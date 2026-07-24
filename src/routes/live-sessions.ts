import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { requireAuth } from "../lib/auth-guard.js";
import { ApiError } from "../lib/errors.js";
import {
  LIVE_GAME_ANSWER_MODES,
  LIVE_GAME_CONTRACT_VERSION,
  LIVE_GAME_MODE_IDS,
  LIVE_GAME_MODE_VERSIONS,
  LIVE_GAME_TEAM_IDS,
  RISK_BET_STARTING_BANK,
  isLiveGameModeId,
  isLiveGameSessionStatus,
  isLiveGameTeamId,
  isSelfPacedModeId,
  type LiveGameAnswerMode,
  type LiveGameModeId,
  type LiveGameSessionSnapshot,
  type LiveGameSessionStatus,
  type LiveGameTeamId,
  type LiveGameTokenRole,
} from "../live-game/contracts.js";
import {
  buildQuestionDrafts,
  generateLiveGameRoomCode,
  isTypedAnswerCorrect,
  normalizeAnswer,
  normalizeLiveGameRoomCode,
  normalizeNickname,
  evaluateSurvivalElimination,
  pickBalancedLiveGameTeam,
  scoreLiveGameAnswer,
  MARATHON_DEFAULT_DURATION_MINUTES,
  MARATHON_MAX_DURATION_MINUTES,
  SPRINT_DURATION_SECONDS,
  SPRINT_QUESTION_COUNT,
  scoreLiveGameBet,
} from "../live-game/engine.js";
import {
  bearerToken,
  createLiveGameToken,
  verifyLiveGameToken,
} from "../live-game/token.js";

interface LiveSessionRouteOptions {
  config: AppConfig;
  prisma: PrismaClient;
}

interface SessionParams {
  id: string;
}

interface CreateSessionBody {
  modeId: string;
  flashcardSetIds: number[];
  questionCount: number;
  questionTimeSeconds: number;
  durationMinutes?: number;
  answerMode?: LiveGameAnswerMode;
}

interface JoinSessionBody {
  roomCode: string;
  nickname: string;
}

interface SubmitAnswerBody {
  roundId: string;
  answer: string;
  idempotencyKey: string;
  bet?: number;
}

interface SelectTeamBody {
  team: string;
}

const sessionParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", format: "uuid" },
  },
} as const;

const createSessionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "modeId",
    "flashcardSetIds",
    "questionCount",
    "questionTimeSeconds",
  ],
  properties: {
    modeId: { type: "string", enum: LIVE_GAME_MODE_IDS },
    flashcardSetIds: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { type: "integer", minimum: 1 },
    },
    questionCount: { type: "integer", minimum: 1, maximum: 50 },
    questionTimeSeconds: { type: "integer", minimum: 5, maximum: 120 },
    durationMinutes: {
      type: "integer",
      minimum: 5,
      maximum: MARATHON_MAX_DURATION_MINUTES,
    },
    answerMode: { type: "string", enum: LIVE_GAME_ANSWER_MODES },
  },
} as const;

const joinSessionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["roomCode", "nickname"],
  properties: {
    roomCode: { type: "string", minLength: 4, maxLength: 16 },
    nickname: { type: "string", minLength: 1, maxLength: 80 },
  },
} as const;

const submitAnswerBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["roundId", "answer", "idempotencyKey"],
  properties: {
    roundId: { type: "string", format: "uuid" },
    answer: { type: "string", minLength: 1, maxLength: 500 },
    idempotencyKey: {
      type: "string",
      minLength: 8,
      maxLength: 64,
      pattern: "^[A-Za-z0-9_-]+$",
    },
    bet: { type: "integer", minimum: 0, maximum: 1_000_000 },
  },
} as const;

const selectTeamBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["team"],
  properties: {
    team: { type: "string", enum: LIVE_GAME_TEAM_IDS },
  },
} as const;

function requireSessionToken(
  request: FastifyRequest,
  config: AppConfig,
  sessionId: string,
  requiredRole?: LiveGameTokenRole,
) {
  const token = bearerToken(request.headers.authorization);
  const payload = verifyLiveGameToken(token ?? undefined, config.authSecret);
  if (
    !payload ||
    payload.sessionId !== sessionId ||
    (requiredRole !== undefined && payload.role !== requiredRole)
  ) {
    throw new ApiError(
      401,
      "LIVE_SESSION_UNAUTHORIZED",
      "A valid live session token is required",
    );
  }
  return payload;
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseSessionSettings(
  value: Prisma.JsonValue | null,
): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Self-paced deadline from settings; null until the session starts. */
function settingsEndsAt(settings: Record<string, unknown>): Date | null {
  if (typeof settings.endsAt !== "string") return null;
  const parsed = new Date(settings.endsAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Self-paced sessions have no host-driven advance: the first snapshot
 * loaded after the deadline flips them to FINISHED. Returns the status the
 * caller should treat as current.
 */
async function lazyFinishSelfPaced(
  prisma: PrismaClient,
  sessionId: string,
  status: LiveGameSessionStatus,
  endsAt: Date | null,
  now: Date,
): Promise<LiveGameSessionStatus> {
  if (status !== "QUESTION" || !endsAt || endsAt.getTime() > now.getTime()) {
    return status;
  }
  await prisma.liveSession.updateMany({
    where: { id: sessionId, status: "QUESTION" },
    data: { status: "FINISHED", endedAt: now, sequence: { increment: 1 } },
  });
  return "FINISHED";
}

async function loadSnapshot(
  prisma: PrismaClient,
  sessionId: string,
  viewerParticipantId?: string,
  now = new Date(),
): Promise<LiveGameSessionSnapshot> {
  const session = await prisma.liveSession.findUnique({
    where: { id: sessionId },
    include: {
      participants: {
        where: { leftAt: null },
        // Eliminated (survival) players sink below everyone still alive.
        orderBy: [{ eliminated: "asc" }, { score: "desc" }, { joinedAt: "asc" }],
      },
    },
  });
  if (!session) {
    throw new ApiError(404, "LIVE_SESSION_NOT_FOUND", "Live session not found");
  }
  if (!isLiveGameModeId(session.modeId)) {
    throw new ApiError(
      500,
      "LIVE_SESSION_MODE_INVALID",
      "The live session uses an unsupported mode",
    );
  }
  if (!isLiveGameSessionStatus(session.status)) {
    throw new ApiError(
      500,
      "LIVE_SESSION_STATE_INVALID",
      "The live session has an invalid state",
    );
  }

  const settings = parseSessionSettings(session.settings);
  const selfPacedMode = isSelfPacedModeId(session.modeId);
  const endsAt = selfPacedMode ? settingsEndsAt(settings) : null;
  const status = selfPacedMode
    ? await lazyFinishSelfPaced(prisma, session.id, session.status, endsAt, now)
    : session.status;
  const totalQuestions =
    typeof settings.questionCount === "number" &&
    Number.isInteger(settings.questionCount) &&
    settings.questionCount > 0
      ? settings.questionCount
      : 0;

  const currentRound = session.currentRoundId
    ? await prisma.liveRound.findUnique({
        where: { id: session.currentRoundId },
      })
    : null;
  const [answeredCount, viewerAnswer] = currentRound
    ? await Promise.all([
        // Practice answers from eliminated players are not part of the
        // host's "answered X" progress.
        prisma.liveAnswer.count({
          where: { roundId: currentRound.id, participant: { eliminated: false } },
        }),
        viewerParticipantId
          ? prisma.liveAnswer.findUnique({
              where: {
                roundId_participantId: {
                  roundId: currentRound.id,
                  participantId: viewerParticipantId,
                },
              },
            })
          : null,
      ])
    : [0, null];
  const revealAnswer = status === "REVEAL" || status === "FINISHED";
  const answerMode: LiveGameAnswerMode =
    settings.answerMode === "typed" ? "typed" : "choice";

  // Self-paced: the viewer plays their own queue — position is simply the
  // number of answers they have submitted in this session.
  const viewerSelfPaced =
    selfPacedMode && viewerParticipantId
      ? await (async () => {
          const answeredCount = await prisma.liveAnswer.count({
            where: {
              participantId: viewerParticipantId,
              round: { sessionId: session.id },
            },
          });
          const nextRound =
            status === "QUESTION" && answeredCount < totalQuestions
              ? await prisma.liveRound.findFirst({
                  where: {
                    sessionId: session.id,
                    sequence: answeredCount + 1,
                  },
                  select: {
                    id: true,
                    sequence: true,
                    prompt: true,
                    options: true,
                  },
                })
              : null;
          return {
            question: nextRound
              ? {
                  id: nextRound.id,
                  sequence: nextRound.sequence,
                  prompt: nextRound.prompt,
                  options: jsonStringArray(nextRound.options),
                }
              : null,
            answeredCount,
          };
        })()
      : undefined;

  return {
    contractVersion: LIVE_GAME_CONTRACT_VERSION,
    id: session.id,
    roomCode: session.roomCode,
    modeId: session.modeId,
    modeVersion: session.modeVersion,
    status,
    sequence: session.sequence,
    totalQuestions,
    answerMode,
    serverTime: now.toISOString(),
    selfPaced:
      selfPacedMode && endsAt ? { endsAt: endsAt.toISOString() } : null,
    currentQuestion: currentRound
      ? {
          id: currentRound.id,
          sequence: currentRound.sequence,
          prompt: currentRound.prompt,
          // Typed mode: options would leak the answer pool, players type blind.
          options:
            answerMode === "typed" ? [] : jsonStringArray(currentRound.options),
          startedAt: currentRound.startedAt?.toISOString() ?? null,
          locksAt: currentRound.locksAt?.toISOString() ?? null,
          answeredCount,
          ...(revealAnswer
            ? { correctAnswer: currentRound.correctAnswer }
            : {}),
        }
      : null,
    participants: session.participants.map((participant) => ({
      id: participant.id,
      nickname: participant.nickname,
      score: participant.score,
      correct: participant.correct,
      total: participant.total,
      streak: participant.streak,
      bestStreak: participant.bestStreak,
      eliminated: participant.eliminated,
      practiceCorrect: participant.practiceCorrect,
      practiceTotal: participant.practiceTotal,
      team:
        participant.team && isLiveGameTeamId(participant.team)
          ? participant.team
          : null,
    })),
    viewer: viewerParticipantId
      ? {
          participantId: viewerParticipantId,
          currentAnswer: viewerAnswer
            ? {
                roundId: viewerAnswer.roundId,
                answer: viewerAnswer.answer,
                isCorrect: viewerAnswer.isCorrect,
                points: viewerAnswer.points,
              }
            : null,
          ...(viewerSelfPaced ? { selfPaced: viewerSelfPaced } : {}),
        }
      : null,
  };
}

async function generateAvailableRoomCode(prisma: PrismaClient) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateLiveGameRoomCode();
    const existing = await prisma.liveSession.findUnique({
      where: { roomCode: code },
      select: { id: true },
    });
    if (!existing) return code;
  }
  throw new ApiError(
    503,
    "LIVE_ROOM_CODE_UNAVAILABLE",
    "A room code could not be allocated",
  );
}

function resolveNickname(requested: string, existing: readonly string[]) {
  const base = normalizeNickname(requested);
  if (!base) {
    throw new ApiError(400, "LIVE_NICKNAME_INVALID", "Nickname is required");
  }
  const used = new Set(existing.map((name) => name.toLocaleLowerCase()));
  if (!used.has(base.toLocaleLowerCase())) return base;

  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const marker = ` (${suffix})`;
    const candidate = `${base.slice(0, 40 - marker.length)}${marker}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new ApiError(
    409,
    "LIVE_NICKNAME_UNAVAILABLE",
    "A unique nickname could not be allocated",
  );
}

async function assertPlayerIsActive(
  prisma: PrismaClient,
  sessionId: string,
  participantId: string,
) {
  const participant = await prisma.liveParticipant.findFirst({
    where: { id: participantId, sessionId, role: "PLAYER", leftAt: null },
    select: { id: true },
  });
  if (!participant) {
    throw new ApiError(
      401,
      "LIVE_PLAYER_NOT_ACTIVE",
      "The player is no longer active in this session",
    );
  }
}

export async function registerLiveSessionRoutes(
  app: FastifyInstance,
  options: LiveSessionRouteOptions,
): Promise<void> {
  const { config, prisma } = options;

  app.post<{ Body: CreateSessionBody }>(
    "/api/v1/live/sessions",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { body: createSessionBodySchema },
    },
    async (request, reply) => {
      const auth = await requireAuth(request, config, prisma);
      if (!isLiveGameModeId(request.body.modeId)) {
        throw new ApiError(
          400,
          "LIVE_MODE_UNSUPPORTED",
          "The selected live game mode is not supported",
        );
      }

      const ownedSets = await prisma.flashcardSet.findMany({
        where: {
          id: { in: request.body.flashcardSetIds },
          userId: auth.userId,
        },
        select: {
          id: true,
          words: { select: { word: true, translation: true } },
        },
      });
      if (ownedSets.length !== request.body.flashcardSetIds.length) {
        throw new ApiError(
          404,
          "LIVE_FLASHCARD_SET_NOT_FOUND",
          "One or more flashcard sets were not found",
        );
      }

      const modeId: LiveGameModeId = request.body.modeId;
      // Sprint always pre-generates a full queue — the two-minute clock is
      // the real limit, not the question count.
      const questionCount =
        modeId === "sprint" ? SPRINT_QUESTION_COUNT : request.body.questionCount;
      const questions = buildQuestionDrafts(
        ownedSets.flatMap((set) => set.words),
        questionCount,
        request.body.questionTimeSeconds,
      );
      if (questions.length === 0) {
        throw new ApiError(
          400,
          "LIVE_NOT_ENOUGH_CONTENT",
          "At least two cards with different translations are required",
        );
      }

      const durationMinutes =
        modeId === "marathon"
          ? Math.min(
              request.body.durationMinutes ?? MARATHON_DEFAULT_DURATION_MINUTES,
              MARATHON_MAX_DURATION_MINUTES,
            )
          : undefined;
      const roomCode = await generateAvailableRoomCode(prisma);
      const settings = {
        flashcardSetIds: request.body.flashcardSetIds,
        questionCount: questions.length,
        questionTimeSeconds: request.body.questionTimeSeconds,
        ...(durationMinutes !== undefined ? { durationMinutes } : {}),
        answerMode: request.body.answerMode ?? "choice",
      } satisfies Prisma.InputJsonObject;
      // Marathon rooms must outlive their configured duration; other modes
      // keep the six-hour cleanup window.
      const expiresAtMs =
        durationMinutes !== undefined
          ? Date.now() + (durationMinutes + 6 * 60) * 60 * 1_000
          : Date.now() + 6 * 60 * 60 * 1_000;
      const session = await prisma.liveSession.create({
        data: {
          hostUserId: auth.userId,
          roomCode,
          modeId,
          modeVersion: LIVE_GAME_MODE_VERSIONS[modeId],
          status: "LOBBY",
          sequence: 0,
          settings,
          expiresAt: new Date(expiresAtMs),
          rounds: {
            create: questions.map((question) => ({
              sequence: question.sequence,
              prompt: question.prompt,
              correctAnswer: question.correctAnswer,
              options: question.options,
              timeLimitSeconds: question.timeLimitSeconds,
            })),
          },
        },
        select: { id: true },
      });
      const hostToken = createLiveGameToken(
        { sessionId: session.id, role: "HOST", participantId: null },
        config.authSecret,
      );

      return reply.status(201).send({
        session: await loadSnapshot(prisma, session.id),
        hostToken,
      });
    },
  );

  app.post<{ Body: JoinSessionBody }>(
    "/api/v1/live/sessions/join",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { body: joinSessionBodySchema },
    },
    async (request, reply) => {
      const roomCode = normalizeLiveGameRoomCode(request.body.roomCode);
      const session = await prisma.liveSession.findUnique({
        where: { roomCode },
        include: {
          participants: {
            where: { leftAt: null },
            select: { nickname: true, team: true },
          },
        },
      });
      if (
        !session ||
        session.status === "FINISHED" ||
        session.expiresAt.getTime() <= Date.now()
      ) {
        throw new ApiError(
          404,
          "LIVE_SESSION_NOT_JOINABLE",
          "The live session is not available",
        );
      }
      // Self-paced rooms accept late joiners (marathon lives on this), but
      // never after the answering deadline has passed.
      if (isSelfPacedModeId(session.modeId)) {
        const joinEndsAt = settingsEndsAt(parseSessionSettings(session.settings));
        if (joinEndsAt && joinEndsAt.getTime() <= Date.now()) {
          throw new ApiError(
            404,
            "LIVE_SESSION_NOT_JOINABLE",
            "The live session is not available",
          );
        }
      }
      if (session.participants.length >= 50) {
        throw new ApiError(409, "LIVE_SESSION_FULL", "The live session is full");
      }

      const nickname = resolveNickname(
        request.body.nickname,
        session.participants.map((participant) => participant.nickname),
      );
      // Team battle: balance the sides on join (switchable in the lobby).
      // Risk mode: everyone starts with the same bank to bet from.
      const team =
        session.modeId === "team_battle"
          ? pickBalancedLiveGameTeam(
              session.participants.map((participant) =>
                participant.team && isLiveGameTeamId(participant.team)
                  ? participant.team
                  : null,
              ),
            )
          : null;
      const participant = await prisma.liveParticipant.create({
        data: {
          sessionId: session.id,
          nickname,
          role: "PLAYER",
          team,
          score: session.modeId === "risk_bet" ? RISK_BET_STARTING_BANK : 0,
        },
        select: { id: true, nickname: true },
      });
      await prisma.liveSession.update({
        where: { id: session.id },
        data: { sequence: { increment: 1 } },
      });
      const playerToken = createLiveGameToken(
        {
          sessionId: session.id,
          role: "PLAYER",
          participantId: participant.id,
        },
        config.authSecret,
      );

      return reply.status(201).send({
        participant,
        playerToken,
        session: await loadSnapshot(prisma, session.id, participant.id),
      });
    },
  );

  app.get<{ Params: SessionParams }>(
    "/api/v1/live/sessions/:id",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: { params: sessionParamsSchema },
    },
    async (request) => {
      const token = requireSessionToken(request, config, request.params.id);
      if (token.role === "PLAYER") {
        await assertPlayerIsActive(
          prisma,
          request.params.id,
          token.participantId!,
        );
        await prisma.liveParticipant.update({
          where: { id: token.participantId! },
          data: { lastSeenAt: new Date() },
        });
      }
      return {
        session: await loadSnapshot(
          prisma,
          request.params.id,
          token.participantId ?? undefined,
        ),
      };
    },
  );

  app.post<{ Params: SessionParams }>(
    "/api/v1/live/sessions/:id/start",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: { params: sessionParamsSchema },
    },
    async (request) => {
      requireSessionToken(request, config, request.params.id, "HOST");
      const session = await prisma.liveSession.findUnique({
        where: { id: request.params.id },
        select: { modeId: true, settings: true },
      });
      if (!session) {
        throw new ApiError(404, "LIVE_SESSION_NOT_FOUND", "Live session not found");
      }
      const firstRound = await prisma.liveRound.findFirst({
        where: { sessionId: request.params.id, state: "PENDING" },
        orderBy: { sequence: "asc" },
      });
      if (!firstRound) {
        throw new ApiError(
          409,
          "LIVE_SESSION_HAS_NO_ROUNDS",
          "The live session has no playable rounds",
        );
      }
      const now = new Date();

      // Self-paced: no shared round is opened — starting just stamps the
      // answering deadline; players consume their own queues until then.
      if (isSelfPacedModeId(session.modeId)) {
        const settings = parseSessionSettings(session.settings);
        const durationMs =
          session.modeId === "sprint"
            ? SPRINT_DURATION_SECONDS * 1_000
            : (typeof settings.durationMinutes === "number" &&
              settings.durationMinutes > 0
                ? Math.min(settings.durationMinutes, MARATHON_MAX_DURATION_MINUTES)
                : MARATHON_DEFAULT_DURATION_MINUTES) * 60_000;
        const endsAt = new Date(now.getTime() + durationMs);
        const claimed = await prisma.liveSession.updateMany({
          where: { id: request.params.id, status: "LOBBY" },
          data: {
            status: "QUESTION",
            startedAt: now,
            settings: {
              ...settings,
              endsAt: endsAt.toISOString(),
            } as Prisma.InputJsonObject,
            sequence: { increment: 1 },
          },
        });
        if (claimed.count !== 1) {
          throw new ApiError(
            409,
            "LIVE_SESSION_ALREADY_STARTED",
            "The live session has already started",
          );
        }
        return { session: await loadSnapshot(prisma, request.params.id) };
      }

      const locksAt = new Date(
        now.getTime() + firstRound.timeLimitSeconds * 1_000,
      );

      await prisma.$transaction(async (transaction) => {
        const claimed = await transaction.liveSession.updateMany({
          where: { id: request.params.id, status: "LOBBY" },
          data: {
            status: "QUESTION",
            startedAt: now,
            currentRoundId: firstRound.id,
            sequence: { increment: 1 },
          },
        });
        if (claimed.count !== 1) {
          throw new ApiError(
            409,
            "LIVE_SESSION_ALREADY_STARTED",
            "The live session has already started",
          );
        }
        await transaction.liveRound.update({
          where: { id: firstRound.id },
          data: { state: "QUESTION", startedAt: now, locksAt },
        });
      });

      return { session: await loadSnapshot(prisma, request.params.id) };
    },
  );

  app.post<{ Params: SessionParams; Body: SubmitAnswerBody }>(
    "/api/v1/live/sessions/:id/answers",
    {
      schema: {
        params: sessionParamsSchema,
        body: submitAnswerBodySchema,
      },
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const token = requireSessionToken(
        request,
        config,
        request.params.id,
        "PLAYER",
      );
      const participantId = token.participantId!;
      await assertPlayerIsActive(prisma, request.params.id, participantId);

      const existingByKey = await prisma.liveAnswer.findUnique({
        where: {
          participantId_idempotencyKey: {
            participantId,
            idempotencyKey: request.body.idempotencyKey,
          },
        },
      });
      if (existingByKey) {
        return {
          answer: {
            accepted: true,
            correct: existingByKey.isCorrect,
            points: existingByKey.points,
          },
          session: await loadSnapshot(prisma, request.params.id, participantId),
        };
      }

      const [session, round, previousAnswer, participant] = await Promise.all([
        prisma.liveSession.findUnique({ where: { id: request.params.id } }),
        prisma.liveRound.findFirst({
          where: { id: request.body.roundId, sessionId: request.params.id },
        }),
        prisma.liveAnswer.findUnique({
          where: {
            roundId_participantId: {
              roundId: request.body.roundId,
              participantId,
            },
          },
        }),
        prisma.liveParticipant.findUnique({ where: { id: participantId } }),
      ]);
      if (!session || !round || !participant) {
        throw new ApiError(404, "LIVE_ROUND_NOT_FOUND", "Live round not found");
      }
      if (previousAnswer) {
        throw new ApiError(
          409,
          "LIVE_ANSWER_ALREADY_SUBMITTED",
          "An answer has already been submitted for this round",
        );
      }
      if (!isLiveGameModeId(session.modeId)) {
        throw new ApiError(
          500,
          "LIVE_SESSION_MODE_INVALID",
          "The live session uses an unsupported mode",
        );
      }

      const sessionSettings = parseSessionSettings(session.settings);
      let responseTimeMs = 0;
      if (isSelfPacedModeId(session.modeId)) {
        // Self-paced: the round only has to be the next one in the player's
        // own queue, submitted before the session-wide deadline.
        const endsAt = settingsEndsAt(sessionSettings);
        if (
          session.status !== "QUESTION" ||
          !endsAt ||
          endsAt.getTime() < Date.now()
        ) {
          throw new ApiError(409, "LIVE_ROUND_CLOSED", "The round is closed");
        }
        const answeredCount = await prisma.liveAnswer.count({
          where: { participantId, round: { sessionId: session.id } },
        });
        if (round.sequence !== answeredCount + 1) {
          throw new ApiError(
            409,
            "LIVE_ROUND_OUT_OF_ORDER",
            "Answer the current question in your queue first",
          );
        }
      } else {
        if (
          session.status !== "QUESTION" ||
          session.currentRoundId !== round.id ||
          round.state !== "QUESTION" ||
          !round.startedAt ||
          !round.locksAt ||
          round.locksAt.getTime() < Date.now()
        ) {
          throw new ApiError(409, "LIVE_ROUND_CLOSED", "The round is closed");
        }
        responseTimeMs = Math.max(
          0,
          Math.min(Date.now() - round.startedAt.getTime(), round.timeLimitSeconds * 1_000),
        );
      }

      const typedMode = sessionSettings.answerMode === "typed";
      const normalized = normalizeAnswer(request.body.answer);
      const isCorrect = typedMode
        ? isTypedAnswerCorrect(request.body.answer, round.correctAnswer)
        : normalized === normalizeAnswer(round.correctAnswer);
      // Eliminated survival players keep answering as practice: no points,
      // no effect on the game — only their practice counters move.
      const isPractice = participant.eliminated;
      // Risk mode: the stake is capped by the player's current bank, so the
      // score can never drop below zero.
      const bet =
        session.modeId === "risk_bet"
          ? Math.min(Math.max(request.body.bet ?? 0, 0), participant.score)
          : 0;
      const points = isPractice
        ? 0
        : session.modeId === "risk_bet"
          ? scoreLiveGameBet(isCorrect, bet)
          : scoreLiveGameAnswer(
              session.modeId,
              isCorrect,
              responseTimeMs,
              round.timeLimitSeconds,
              participant.streak,
            );
      const nextStreak = isCorrect ? participant.streak + 1 : 0;

      try {
        await prisma.$transaction(async (transaction) => {
          await transaction.liveAnswer.create({
            data: {
              roundId: round.id,
              participantId,
              answer: request.body.answer,
              normalizedAnswer: normalized,
              isCorrect,
              points,
              responseTimeMs,
              idempotencyKey: request.body.idempotencyKey,
            },
          });
          await transaction.liveParticipant.update({
            where: { id: participantId },
            data: isPractice
              ? {
                  practiceCorrect: { increment: isCorrect ? 1 : 0 },
                  practiceTotal: { increment: 1 },
                  lastSeenAt: new Date(),
                }
              : {
                  score: { increment: points },
                  correct: { increment: isCorrect ? 1 : 0 },
                  total: { increment: 1 },
                  streak: nextStreak,
                  bestStreak: Math.max(participant.bestStreak, nextStreak),
                  lastSeenAt: new Date(),
                },
          });
          await transaction.liveSession.update({
            where: { id: session.id },
            data: { sequence: { increment: 1 } },
          });
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const retried = await prisma.liveAnswer.findUnique({
            where: {
              participantId_idempotencyKey: {
                participantId,
                idempotencyKey: request.body.idempotencyKey,
              },
            },
          });
          if (retried) {
            return reply.send({
              answer: {
                accepted: true,
                correct: retried.isCorrect,
                points: retried.points,
              },
              session: await loadSnapshot(
                prisma,
                request.params.id,
                participantId,
              ),
            });
          }
          throw new ApiError(
            409,
            "LIVE_ANSWER_ALREADY_SUBMITTED",
            "An answer has already been submitted for this round",
          );
        }
        throw error;
      }

      return reply.status(201).send({
        answer: { accepted: true, correct: isCorrect, points },
        session: await loadSnapshot(prisma, request.params.id, participantId),
      });
    },
  );

  app.post<{ Params: SessionParams }>(
    "/api/v1/live/sessions/:id/advance",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: { params: sessionParamsSchema },
    },
    async (request) => {
      requireSessionToken(request, config, request.params.id, "HOST");
      const session = await prisma.liveSession.findUnique({
        where: { id: request.params.id },
      });
      if (!session) {
        throw new ApiError(404, "LIVE_SESSION_NOT_FOUND", "Live session not found");
      }
      if (isSelfPacedModeId(session.modeId)) {
        throw new ApiError(
          409,
          "LIVE_SESSION_CANNOT_ADVANCE",
          "Self-paced sessions have no shared rounds to advance",
        );
      }
      if (!session.currentRoundId) {
        throw new ApiError(
          409,
          "LIVE_SESSION_NOT_STARTED",
          "The live session has not started",
        );
      }
      const currentRound = await prisma.liveRound.findUnique({
        where: { id: session.currentRoundId },
      });
      if (!currentRound) {
        throw new ApiError(500, "LIVE_ROUND_NOT_FOUND", "Live round not found");
      }

      if (session.status === "QUESTION") {
        const now = new Date();
        await prisma.$transaction(async (transaction) => {
          const claimed = await transaction.liveSession.updateMany({
            where: {
              id: session.id,
              status: "QUESTION",
              currentRoundId: currentRound.id,
            },
            data: { status: "REVEAL", sequence: { increment: 1 } },
          });
          if (claimed.count !== 1) {
            throw new ApiError(
              409,
              "LIVE_SESSION_STATE_CHANGED",
              "The live session was already advanced",
            );
          }
          await transaction.liveRound.update({
            where: { id: currentRound.id },
            data: { state: "REVEAL", revealedAt: now },
          });

          if (session.modeId === "survival") {
            const alive = await transaction.liveParticipant.findMany({
              where: { sessionId: session.id, leftAt: null, eliminated: false },
              select: { id: true },
            });
            const answers = await transaction.liveAnswer.findMany({
              where: {
                roundId: currentRound.id,
                participantId: { in: alive.map((player) => player.id) },
              },
              select: { participantId: true, isCorrect: true },
            });
            const answeredCorrect = new Map(
              answers.map((answer) => [answer.participantId, answer.isCorrect]),
            );
            const toEliminate = evaluateSurvivalElimination(
              alive.map((player) => ({
                id: player.id,
                answeredCorrect: answeredCorrect.get(player.id) === true,
              })),
            );
            if (toEliminate.length > 0) {
              await transaction.liveParticipant.updateMany({
                where: { id: { in: toEliminate } },
                data: { eliminated: true, streak: 0 },
              });
            }
          }
        });
      } else if (session.status === "REVEAL") {
        const nextRound = await prisma.liveRound.findFirst({
          where: {
            sessionId: session.id,
            state: "PENDING",
            sequence: { gt: currentRound.sequence },
          },
          orderBy: { sequence: "asc" },
        });
        // Survival ends early once at most one player is still standing.
        const survivalOver =
          session.modeId === "survival" &&
          (await prisma.liveParticipant.count({
            where: { sessionId: session.id, leftAt: null, eliminated: false },
          })) <= 1;
        if (!nextRound || survivalOver) {
          const finished = await prisma.liveSession.updateMany({
            where: {
              id: session.id,
              status: "REVEAL",
              currentRoundId: currentRound.id,
            },
            data: {
              status: "FINISHED",
              endedAt: new Date(),
              sequence: { increment: 1 },
            },
          });
          if (finished.count !== 1) {
            throw new ApiError(
              409,
              "LIVE_SESSION_STATE_CHANGED",
              "The live session was already advanced",
            );
          }
        } else {
          const now = new Date();
          const locksAt = new Date(
            now.getTime() + nextRound.timeLimitSeconds * 1_000,
          );
          await prisma.$transaction(async (transaction) => {
            const claimed = await transaction.liveSession.updateMany({
              where: {
                id: session.id,
                status: "REVEAL",
                currentRoundId: currentRound.id,
              },
              data: {
                status: "QUESTION",
                currentRoundId: nextRound.id,
                sequence: { increment: 1 },
              },
            });
            if (claimed.count !== 1) {
              throw new ApiError(
                409,
                "LIVE_SESSION_STATE_CHANGED",
                "The live session was already advanced",
              );
            }
            await transaction.liveRound.update({
              where: { id: nextRound.id },
              data: { state: "QUESTION", startedAt: now, locksAt },
            });
          });
        }
      } else {
        throw new ApiError(
          409,
          "LIVE_SESSION_CANNOT_ADVANCE",
          "The live session cannot advance from its current state",
        );
      }

      return { session: await loadSnapshot(prisma, request.params.id) };
    },
  );

  app.post<{ Params: SessionParams; Body: SelectTeamBody }>(
    "/api/v1/live/sessions/:id/team",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { params: sessionParamsSchema, body: selectTeamBodySchema },
    },
    async (request) => {
      const token = requireSessionToken(
        request,
        config,
        request.params.id,
        "PLAYER",
      );
      const participantId = token.participantId!;
      await assertPlayerIsActive(prisma, request.params.id, participantId);

      const session = await prisma.liveSession.findUnique({
        where: { id: request.params.id },
        select: { id: true, modeId: true, status: true },
      });
      if (!session) {
        throw new ApiError(404, "LIVE_SESSION_NOT_FOUND", "Live session not found");
      }
      if (
        session.modeId !== "team_battle" ||
        session.status !== "LOBBY" ||
        !isLiveGameTeamId(request.body.team)
      ) {
        throw new ApiError(
          409,
          "LIVE_TEAM_SELECTION_UNAVAILABLE",
          "Teams can only be picked in the lobby of a team battle",
        );
      }
      const team: LiveGameTeamId = request.body.team;

      await prisma.$transaction(async (transaction) => {
        await transaction.liveParticipant.update({
          where: { id: participantId },
          data: { team, lastSeenAt: new Date() },
        });
        await transaction.liveSession.update({
          where: { id: session.id },
          data: { sequence: { increment: 1 } },
        });
      });

      return {
        session: await loadSnapshot(prisma, request.params.id, participantId),
      };
    },
  );

  app.post<{ Params: SessionParams }>(
    "/api/v1/live/sessions/:id/leave",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: { params: sessionParamsSchema },
    },
    async (request, reply) => {
      const token = requireSessionToken(
        request,
        config,
        request.params.id,
        "PLAYER",
      );
      const participantId = token.participantId!;
      const now = new Date();

      await prisma.$transaction(async (transaction) => {
        const left = await transaction.liveParticipant.updateMany({
          where: {
            id: participantId,
            sessionId: request.params.id,
            leftAt: null,
          },
          data: { leftAt: now, lastSeenAt: now },
        });
        if (left.count === 1) {
          await transaction.liveSession.update({
            where: { id: request.params.id },
            data: { sequence: { increment: 1 } },
          });
        }
      });

      return reply.status(204).send();
    },
  );

  app.post<{ Params: SessionParams }>(
    "/api/v1/live/sessions/:id/finish",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: { params: sessionParamsSchema },
    },
    async (request) => {
      requireSessionToken(request, config, request.params.id, "HOST");
      const updated = await prisma.liveSession.updateMany({
        where: { id: request.params.id, status: { not: "FINISHED" } },
        data: {
          status: "FINISHED",
          endedAt: new Date(),
          sequence: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ApiError(
          409,
          "LIVE_SESSION_ALREADY_FINISHED",
          "The live session is already finished",
        );
      }
      return { session: await loadSnapshot(prisma, request.params.id) };
    },
  );
}
