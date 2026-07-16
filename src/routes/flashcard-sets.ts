import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { requireAuth } from "../lib/auth-guard.js";
import { ApiError } from "../lib/errors.js";
import {
  canonicalTagKey,
  FLASHCARD_SET_LIMITS,
  flashcardSetBodySchema,
  normalizeFlashcardSetInput,
  type FlashcardSetInput,
  type NormalizedFlashcardWordInput,
} from "../lib/flashcard-set-input.js";
import { parsePositiveIntId } from "../lib/ids.js";

interface FlashcardSetRouteOptions {
  config: AppConfig;
  prisma: PrismaClient;
}

interface IdParams {
  id: string;
}

interface WordMediaReference {
  id: number;
  imageId: number | null;
  audioId: number | null;
}

const idParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", pattern: "^[1-9][0-9]*$", maxLength: 10 },
  },
} as const;

function wordContentData(word: NormalizedFlashcardWordInput) {
  return {
    word: word.word,
    translation: word.translation,
    difficulty: word.difficulty,
    pronunciation: word.pronunciation,
  };
}

async function assertUserTagLimit(
  transaction: Prisma.TransactionClient,
  userId: number,
  requestedTags: readonly string[],
  excludeSetId?: number,
): Promise<void> {
  const where: Prisma.FlashcardSetWhereInput = { userId };
  if (excludeSetId !== undefined) where.id = { not: excludeSetId };

  const otherSets = await transaction.flashcardSet.findMany({
    where,
    select: { tags: true },
  });
  const uniqueTagKeys = new Set<string>();
  for (const set of otherSets) {
    for (const tag of set.tags) {
      const key = canonicalTagKey(tag);
      if (key) uniqueTagKeys.add(key);
    }
  }
  const existingCount = uniqueTagKeys.size;
  for (const tag of requestedTags) uniqueTagKeys.add(canonicalTagKey(tag));

  if (uniqueTagKeys.size > FLASHCARD_SET_LIMITS.tagsPerUser) {
    throw new ApiError(
      400,
      "USER_TAG_LIMIT_EXCEEDED",
      `A user may have at most ${FLASHCARD_SET_LIMITS.tagsPerUser} unique tags across all flashcard sets`,
      {
        maximum: FLASHCARD_SET_LIMITS.tagsPerUser,
        existing: existingCount,
        requestedTotal: uniqueTagKeys.size,
      },
    );
  }
}

function collectMediaIds(words: readonly WordMediaReference[]) {
  return {
    imageIds: words.flatMap((word) =>
      word.imageId === null ? [] : [word.imageId],
    ),
    audioIds: words.flatMap((word) =>
      word.audioId === null ? [] : [word.audioId],
    ),
  };
}

async function cleanupDetachedMedia(
  transaction: Prisma.TransactionClient,
  words: readonly WordMediaReference[],
): Promise<void> {
  const { imageIds, audioIds } = collectMediaIds(words);
  if (imageIds.length > 0) {
    await transaction.wordImage.deleteMany({
      where: { id: { in: imageIds } },
    });
  }
  if (audioIds.length > 0) {
    await transaction.wordAudio.deleteMany({
      where: { id: { in: audioIds } },
    });
  }
}

export async function registerFlashcardSetRoutes(
  app: FastifyInstance,
  options: FlashcardSetRouteOptions,
): Promise<void> {
  const { config, prisma } = options;

  app.get("/api/v1/flashcard-sets", async (request) => {
    const auth = await requireAuth(request, config, prisma);
    const userExists = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { id: true },
    });
    if (!userExists) {
      throw new ApiError(401, "UNAUTHORIZED", "Unauthorized");
    }

    const flashcardSets = await prisma.flashcardSet.findMany({
      where: { userId: auth.userId },
      include: {
        words: {
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Preserve the legacy response invariant without mutating data during GET.
    const compatibleSets = flashcardSets.map((set) =>
      set.isAIGenerated && !set.tags.includes("AI Generated")
        ? { ...set, tags: [...set.tags, "AI Generated"] }
        : set,
    );

    return { flashcardSets: compatibleSets };
  });

  app.post<{ Body: FlashcardSetInput }>(
    "/api/v1/flashcard-sets",
    { schema: { body: flashcardSetBodySchema } },
    async (request, reply) => {
      const auth = await requireAuth(request, config, prisma);
      const input = normalizeFlashcardSetInput(request.body);
      const submittedIds = input.words
        .map((word) => word.id)
        .filter((id): id is number => id !== undefined);
      if (submittedIds.length > 0) {
        throw new ApiError(
          400,
          "WORD_ID_NOT_ALLOWED",
          "Word IDs cannot be supplied when creating a flashcard set",
          { wordIds: submittedIds },
        );
      }

      const flashcardSet = await prisma.$transaction(async (transaction) => {
        const userExists = await transaction.user.findUnique({
          where: { id: auth.userId },
          select: { id: true },
        });
        if (!userExists) {
          throw new ApiError(401, "UNAUTHORIZED", "Unauthorized");
        }

        const existingSetCount = await transaction.flashcardSet.count({
          where: { userId: auth.userId },
        });
        if (existingSetCount >= FLASHCARD_SET_LIMITS.setsPerUser) {
          throw new ApiError(
            400,
            "FLASHCARD_SET_LIMIT_EXCEEDED",
            `A user may have at most ${FLASHCARD_SET_LIMITS.setsPerUser} flashcard sets`,
            { maximum: FLASHCARD_SET_LIMITS.setsPerUser },
          );
        }

        await assertUserTagLimit(
          transaction,
          auth.userId,
          input.tags,
        );

        return transaction.flashcardSet.create({
          data: {
            name: input.name,
            userId: auth.userId,
            fromLanguage: input.fromLanguage,
            toLanguage: input.toLanguage,
            isAIGenerated: false,
            tags: input.tags,
            isPublic: false,
            publicCode: null,
            joinedFromCode: null,
            words: {
              create: input.words.map((word) => ({
                ...wordContentData(word),
                userId: auth.userId,
              })),
            },
          },
          include: {
            words: { orderBy: { createdAt: "asc" } },
          },
        });
      });

      return reply.status(201).send({ flashcardSet });
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/flashcard-sets/:id",
    { schema: { params: idParamsSchema } },
    async (request) => {
      const auth = await requireAuth(request, config, prisma);
      const setId = parsePositiveIntId(request.params.id, "flashcard set");

      const flashcardSet = await prisma.flashcardSet.findFirst({
        where: {
          id: setId,
          userId: auth.userId,
        },
        include: {
          words: {
            orderBy: { createdAt: "asc" },
          },
        },
      });

      if (!flashcardSet) {
        throw new ApiError(
          404,
          "FLASHCARD_SET_NOT_FOUND",
          "Flashcard set not found",
        );
      }

      return { flashcardSet };
    },
  );

  app.patch<{ Params: IdParams; Body: FlashcardSetInput }>(
    "/api/v1/flashcard-sets/:id",
    {
      schema: {
        params: idParamsSchema,
        body: flashcardSetBodySchema,
      },
    },
    async (request) => {
      const auth = await requireAuth(request, config, prisma);
      const setId = parsePositiveIntId(request.params.id, "flashcard set");
      const input = normalizeFlashcardSetInput(request.body);

      const flashcardSet = await prisma.$transaction(async (transaction) => {
        const existingSet = await transaction.flashcardSet.findFirst({
          where: { id: setId, userId: auth.userId },
          select: {
            id: true,
            words: {
              select: { id: true, imageId: true, audioId: true },
            },
          },
        });
        if (!existingSet) {
          throw new ApiError(
            404,
            "FLASHCARD_SET_NOT_FOUND",
            "Flashcard set not found",
          );
        }

        const existingWordsById = new Map(
          existingSet.words.map((word) => [word.id, word]),
        );
        const submittedWordIds = input.words
          .map((word) => word.id)
          .filter((id): id is number => id !== undefined);
        const foreignWordIds = submittedWordIds.filter(
          (wordId) => !existingWordsById.has(wordId),
        );
        if (foreignWordIds.length > 0) {
          throw new ApiError(
            400,
            "WORD_NOT_IN_FLASHCARD_SET",
            "One or more word IDs do not belong to this flashcard set",
            { wordIds: foreignWordIds },
          );
        }

        await assertUserTagLimit(
          transaction,
          auth.userId,
          input.tags,
          setId,
        );

        const submittedWordIdSet = new Set(submittedWordIds);
        const omittedWords = existingSet.words.filter(
          (word) => !submittedWordIdSet.has(word.id),
        );

        for (const word of input.words) {
          if (word.id === undefined) {
            await transaction.word.create({
              data: {
                ...wordContentData(word),
                userId: auth.userId,
                flashcardSetId: setId,
              },
            });
          } else {
            await transaction.word.update({
              where: { id: word.id },
              data: wordContentData(word),
            });
          }
        }

        if (omittedWords.length > 0) {
          await transaction.word.deleteMany({
            where: {
              id: { in: omittedWords.map((word) => word.id) },
              flashcardSetId: setId,
              userId: auth.userId,
            },
          });
          await cleanupDetachedMedia(transaction, omittedWords);
        }

        return transaction.flashcardSet.update({
          where: { id: setId },
          data: {
            name: input.name,
            fromLanguage: input.fromLanguage,
            toLanguage: input.toLanguage,
            tags: input.tags,
          },
          include: {
            words: { orderBy: { createdAt: "asc" } },
          },
        });
      });

      return { flashcardSet };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/api/v1/flashcard-sets/:id",
    { schema: { params: idParamsSchema } },
    async (request) => {
      const auth = await requireAuth(request, config, prisma);
      const setId = parsePositiveIntId(request.params.id, "flashcard set");

      await prisma.$transaction(async (transaction) => {
        const existingSet = await transaction.flashcardSet.findFirst({
          where: { id: setId, userId: auth.userId },
          select: {
            id: true,
            words: {
              select: { id: true, imageId: true, audioId: true },
            },
          },
        });
        if (!existingSet) {
          throw new ApiError(
            404,
            "FLASHCARD_SET_NOT_FOUND",
            "Flashcard set not found",
          );
        }

        // Deleting the set first releases the Word -> media foreign keys.
        await transaction.flashcardSet.delete({ where: { id: setId } });
        await cleanupDetachedMedia(transaction, existingSet.words);
      });

      return { message: "Flashcard set deleted successfully" };
    },
  );
}
