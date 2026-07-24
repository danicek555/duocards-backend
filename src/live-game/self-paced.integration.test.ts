import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { createLiveGameToken } from "./token.js";
import type { LiveGameSessionSnapshot } from "./contracts.js";
import { SPRINT_DURATION_SECONDS } from "./engine.js";

const sessionId = "22222222-2222-4222-8222-222222222222";
const participantId = "33333333-3333-4333-8333-333333333333";
const roundId = "44444444-4444-4444-8444-444444444444";
const config = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 4000,
  logLevel: "silent",
  trustProxy: false,
  databaseUrl: "postgresql://unused.test/duocards",
  authSecret: "test-secret-with-at-least-thirty-two-bytes",
  redisUrl: null,
  corsOrigins: [],
  cookieSecure: false,
  verificationEmailMode: "resend",
  resendApiKey: null,
  emailFrom: "DuoCards <notifications@example.test>",
  publicAppUrl: "https://app.example.test",
} satisfies AppConfig;

const hostToken = createLiveGameToken(
  { sessionId, role: "HOST", participantId: null },
  config.authSecret,
);
const playerToken = createLiveGameToken(
  { sessionId, role: "PLAYER", participantId },
  config.authSecret,
);

function sprintSession(overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    hostUserId: 42,
    roomCode: "SPRNT2",
    modeId: "sprint",
    modeVersion: 1,
    status: "LOBBY",
    sequence: 0,
    settings: { flashcardSetIds: [5], questionCount: 3, questionTimeSeconds: 20 },
    currentRoundId: null,
    startedAt: null,
    endedAt: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    participants: [],
    ...overrides,
  };
}

test("starting a sprint stamps endsAt and opens no shared round", async (t) => {
  let updateManyData: Record<string, unknown> | undefined;
  let started = false;
  const prisma = {
    liveSession: {
      findUnique: async () =>
        started
          ? sprintSession({
              status: "QUESTION",
              settings: {
                flashcardSetIds: [5],
                questionCount: 3,
                questionTimeSeconds: 20,
                endsAt: new Date(
                  Date.now() + SPRINT_DURATION_SECONDS * 1_000,
                ).toISOString(),
              },
            })
          : sprintSession(),
      updateMany: async (args: { data: Record<string, unknown> }) => {
        updateManyData = args.data;
        started = true;
        return { count: 1 };
      },
    },
    liveRound: {
      findFirst: async () => ({
        id: roundId,
        sessionId,
        sequence: 1,
        state: "PENDING",
        timeLimitSeconds: 20,
      }),
      findUnique: async () => null,
    },
  } as unknown as PrismaClient;

  const app = await buildApp({ config, prisma });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: `/api/v1/live/sessions/${sessionId}/start`,
    headers: { authorization: `Bearer ${hostToken}` },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.ok(updateManyData);
  const settings = updateManyData.settings as { endsAt?: string };
  assert.ok(settings.endsAt, "start must stamp settings.endsAt");
  const endsInMs = new Date(settings.endsAt!).getTime() - Date.now();
  assert.ok(
    endsInMs > (SPRINT_DURATION_SECONDS - 5) * 1_000 &&
      endsInMs <= SPRINT_DURATION_SECONDS * 1_000,
    `sprint deadline should be ~${SPRINT_DURATION_SECONDS}s ahead, got ${endsInMs}ms`,
  );
  assert.equal(updateManyData.currentRoundId, undefined);
  const body = response.json<{ session: LiveGameSessionSnapshot }>();
  assert.equal(body.session.status, "QUESTION");
  assert.equal(body.session.currentQuestion, null);
  assert.ok(body.session.selfPaced?.endsAt);
});

test("sprint answers must follow the player's own queue order", async (t) => {
  const futureEndsAt = new Date(Date.now() + 60_000).toISOString();
  const prisma = {
    liveAnswer: {
      findUnique: async () => null,
      count: async () => 0,
    },
    liveParticipant: {
      findFirst: async () => ({ id: participantId }),
      findUnique: async () => ({
        id: participantId,
        eliminated: false,
        streak: 0,
        bestStreak: 0,
      }),
    },
    liveSession: {
      findUnique: async () =>
        sprintSession({
          status: "QUESTION",
          settings: {
            flashcardSetIds: [5],
            questionCount: 3,
            questionTimeSeconds: 20,
            endsAt: futureEndsAt,
          },
        }),
    },
    liveRound: {
      // Round with sequence 2 while the player has answered 0 questions.
      findFirst: async () => ({
        id: roundId,
        sessionId,
        sequence: 2,
        state: "PENDING",
        prompt: "two",
        correctAnswer: "dva",
        options: ["dva", "tri"],
        timeLimitSeconds: 20,
        startedAt: null,
        locksAt: null,
      }),
    },
  } as unknown as PrismaClient;

  const app = await buildApp({ config, prisma });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: `/api/v1/live/sessions/${sessionId}/answers`,
    headers: {
      authorization: `Bearer ${playerToken}`,
      "content-type": "application/json",
    },
    payload: { roundId, answer: "dva", idempotencyKey: "abcdefgh" },
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(
    response.json<{ error: { code: string } }>().error.code,
    "LIVE_ROUND_OUT_OF_ORDER",
  );
});

test("advance is rejected for self-paced sessions", async (t) => {
  const prisma = {
    liveSession: {
      findUnique: async () => sprintSession({ status: "QUESTION" }),
    },
  } as unknown as PrismaClient;

  const app = await buildApp({ config, prisma });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: `/api/v1/live/sessions/${sessionId}/advance`,
    headers: { authorization: `Bearer ${hostToken}` },
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(
    response.json<{ error: { code: string } }>().error.code,
    "LIVE_SESSION_CANNOT_ADVANCE",
  );
});

test("a snapshot loaded after the deadline lazily finishes the session", async (t) => {
  let finishedData: Record<string, unknown> | undefined;
  const pastEndsAt = new Date(Date.now() - 1_000).toISOString();
  const prisma = {
    liveSession: {
      findUnique: async () =>
        sprintSession({
          status: "QUESTION",
          settings: {
            flashcardSetIds: [5],
            questionCount: 3,
            questionTimeSeconds: 20,
            endsAt: pastEndsAt,
          },
        }),
      updateMany: async (args: { data: Record<string, unknown> }) => {
        finishedData = args.data;
        return { count: 1 };
      },
    },
    liveRound: {
      findUnique: async () => null,
    },
  } as unknown as PrismaClient;

  const app = await buildApp({ config, prisma });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/api/v1/live/sessions/${sessionId}`,
    headers: { authorization: `Bearer ${hostToken}` },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(finishedData?.status, "FINISHED");
  const body = response.json<{ session: LiveGameSessionSnapshot }>();
  assert.equal(body.session.status, "FINISHED");
});

test("marathon rooms accept joins while running, but not past the deadline", async (t) => {
  const marathon = (endsAt: string) =>
    sprintSession({
      modeId: "marathon",
      roomCode: "MRTHN2",
      status: "QUESTION",
      settings: {
        flashcardSetIds: [5],
        questionCount: 3,
        questionTimeSeconds: 20,
        durationMinutes: 60,
        endsAt,
      },
    });

  let sessionEndsAt = new Date(Date.now() + 60_000).toISOString();
  let joined = false;
  const prisma = {
    liveSession: {
      findUnique: async (args: { where: { id?: string; roomCode?: string } }) =>
        args.where.roomCode === "MRTHN2" || args.where.id === sessionId
          ? marathon(sessionEndsAt)
          : null,
      update: async () => ({}),
    },
    liveParticipant: {
      create: async () => {
        joined = true;
        return { id: participantId, nickname: "late-student" };
      },
    },
    liveAnswer: {
      findUnique: async () => null,
      count: async () => 0,
    },
    liveRound: {
      findUnique: async () => null,
      findFirst: async () => null,
    },
  } as unknown as PrismaClient;

  const app = await buildApp({ config, prisma });
  t.after(async () => app.close());

  const joinRunning = await app.inject({
    method: "POST",
    url: "/api/v1/live/sessions/join",
    headers: { "content-type": "application/json" },
    payload: { roomCode: "MRTHN2", nickname: "late-student" },
  });
  assert.equal(joinRunning.statusCode, 201, joinRunning.body);
  assert.equal(joined, true);

  sessionEndsAt = new Date(Date.now() - 1_000).toISOString();
  const joinLate = await app.inject({
    method: "POST",
    url: "/api/v1/live/sessions/join",
    headers: { "content-type": "application/json" },
    payload: { roomCode: "MRTHN2", nickname: "too-late" },
  });
  assert.equal(joinLate.statusCode, 404, joinLate.body);
});
