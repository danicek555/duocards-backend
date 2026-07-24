import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { createAuthToken } from "./auth-token.js";

const userId = 7;
const userEmail = "user@example.test";
const passwordHash = "$argon2id$test-current-password-hash";
const config = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 4000,
  logLevel: "silent",
  trustProxy: false,
  databaseUrl: "postgresql://unused.test/duocards",
  authSecret: "test-secret-with-at-least-thirty-two-bytes",
  redisUrl: null,
  corsOrigins: ["https://app.example.test"],
  cookieSecure: false,
  verificationEmailMode: "resend",
  resendApiKey: null,
  emailFrom: "DuoCards <notifications@example.test>",
  publicAppUrl: "https://app.example.test",
} satisfies AppConfig;

const authCookie = `auth=${createAuthToken(
  { userId, email: userEmail },
  config.authSecret,
  passwordHash,
)}`;

interface WordWriteData {
  word: string;
  translation: string;
  difficulty: number;
  pronunciation: string | null;
  userId?: number;
  flashcardSetId?: number;
}

interface CreateSetData {
  name: string;
  userId: number;
  fromLanguage: string | null;
  toLanguage: string | null;
  isAIGenerated: boolean;
  tags: string[];
  isPublic: boolean;
  publicCode: string | null;
  joinedFromCode: string | null;
  words: { create: WordWriteData[] };
}

function transactionalPrisma(transaction: object): PrismaClient {
  return {
    user: {
      findUnique: async () => ({
        id: userId,
        email: userEmail,
        password: passwordHash,
      }),
    },
    async $transaction<T>(
      callback: (client: object) => Promise<T>,
    ): Promise<T> {
      return callback(transaction);
    },
  } as unknown as PrismaClient;
}

function jsonHeaders(requestId: string) {
  return {
    cookie: authCookie,
    "x-request-id": requestId,
    "content-type": "application/json",
  };
}

test("POST creates a normalized private text-only set", async (t) => {
  let capturedCreateData: CreateSetData | undefined;
  const transaction = {
    user: {
      findUnique: async () => ({ id: userId }),
    },
    flashcardSet: {
      count: async () => 3,
      findMany: async () => [{ tags: ["Existing"] }],
      create: async (args: { data: CreateSetData }) => {
        capturedCreateData = args.data;
        return {
          id: 55,
          ...args.data,
          createdAt: new Date("2026-07-15T10:00:00.000Z"),
          updatedAt: new Date("2026-07-15T10:00:00.000Z"),
          words: args.data.words.create.map((word, index) => ({
            id: 500 + index,
            ...word,
            flashcardSetId: 55,
            imageId: null,
            audioId: null,
          })),
        };
      },
    },
  };
  const app = await buildApp({
    config,
    prisma: transactionalPrisma(transaction),
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/flashcard-sets",
    headers: jsonHeaders("create-set"),
    payload: {
      name: "  German basics  ",
      fromLanguage: "  cs ",
      toLanguage: " de  ",
      tags: [" Travel ", "travel", " Daily   words ", ""],
      words: [
        {
          word: " Hallo ",
          translation: " Ahoj ",
          difficulty: 2,
          pronunciation: " ha-lo ",
        },
      ],
    },
  });

  assert.equal(response.statusCode, 201);
  assert.ok(capturedCreateData);
  assert.deepEqual(capturedCreateData, {
    name: "German basics",
    userId,
    fromLanguage: "cs",
    toLanguage: "de",
    isAIGenerated: false,
    tags: ["Travel", "Daily words"],
    isPublic: false,
    publicCode: null,
    joinedFromCode: null,
    words: {
      create: [
        {
          word: "Hallo",
          translation: "Ahoj",
          difficulty: 2,
          pronunciation: "ha-lo",
          userId,
        },
      ],
    },
  });
  const payload = response.json<{
    flashcardSet: { id: number; isPublic: boolean; publicCode: string | null };
  }>();
  assert.deepEqual(
    {
      id: payload.flashcardSet.id,
      isPublic: payload.flashcardSet.isPublic,
      publicCode: payload.flashcardSet.publicCode,
    },
    { id: 55, isPublic: false, publicCode: null },
  );
});

test("write schema rejects public fields before touching Prisma", async (t) => {
  const prisma = {
    async $transaction() {
      throw new Error("Prisma must not be called for an invalid body");
    },
  } as unknown as PrismaClient;
  const app = await buildApp({ config, prisma });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/flashcard-sets",
    headers: jsonHeaders("reject-public-fields"),
    payload: {
      name: "Private set",
      tags: [],
      words: [{ word: "one", translation: "jedna", difficulty: 1 }],
      isPublic: true,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.json<{ error: { code: string } }>().error.code,
    "VALIDATION_ERROR",
  );
});

test("PATCH diffs stable word IDs and cleans omitted media", async (t) => {
  const operationOrder: string[] = [];
  const wordUpdates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const wordCreates: WordWriteData[] = [];
  let setLookupWhere: unknown;
  let setUpdateData: Record<string, unknown> | undefined;
  let deletedWordWhere: unknown;
  let deletedImageWhere: unknown;
  let deletedAudioWhere: unknown;

  const finalSet = {
    id: 10,
    userId,
    name: "Updated set",
    fromLanguage: "cs",
    toLanguage: "de",
    isAIGenerated: false,
    tags: ["Shared", "Fresh"],
    isPublic: true,
    publicCode: "PUBLIC-123",
    joinedFromCode: null,
    words: [
      {
        id: 101,
        word: "updated",
        translation: "upraveno",
        difficulty: 3,
        pronunciation: "up",
        imageId: 201,
        audioId: 301,
      },
      {
        id: 103,
        word: "new",
        translation: "nové",
        difficulty: 1,
        pronunciation: null,
        imageId: null,
        audioId: null,
      },
    ],
  };

  const transaction = {
    flashcardSet: {
      findFirst: async (args: { where: unknown }) => {
        setLookupWhere = args.where;
        return {
          id: 10,
          words: [
            { id: 101, imageId: 201, audioId: 301 },
            { id: 102, imageId: 202, audioId: 302 },
          ],
        };
      },
      findMany: async () => [{ tags: ["shared"] }],
      update: async (args: {
        data: Record<string, unknown>;
      }) => {
        operationOrder.push("flashcardSet.update");
        setUpdateData = args.data;
        return finalSet;
      },
    },
    word: {
      update: async (args: {
        where: unknown;
        data: Record<string, unknown>;
      }) => {
        operationOrder.push("word.update");
        wordUpdates.push(args);
        return { id: 101, ...args.data };
      },
      create: async (args: { data: WordWriteData }) => {
        operationOrder.push("word.create");
        wordCreates.push(args.data);
        return { id: 103, ...args.data };
      },
      deleteMany: async (args: { where: unknown }) => {
        operationOrder.push("word.deleteMany");
        deletedWordWhere = args.where;
        return { count: 1 };
      },
    },
    wordImage: {
      deleteMany: async (args: { where: unknown }) => {
        operationOrder.push("wordImage.deleteMany");
        deletedImageWhere = args.where;
        return { count: 1 };
      },
    },
    wordAudio: {
      deleteMany: async (args: { where: unknown }) => {
        operationOrder.push("wordAudio.deleteMany");
        deletedAudioWhere = args.where;
        return { count: 1 };
      },
    },
  };
  const app = await buildApp({
    config,
    prisma: transactionalPrisma(transaction),
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "PATCH",
    url: "/api/v1/flashcard-sets/10",
    headers: jsonHeaders("patch-set"),
    payload: {
      name: " Updated set ",
      fromLanguage: "cs",
      toLanguage: "de",
      tags: [" Shared ", "Fresh"],
      words: [
        {
          id: 101,
          word: " updated ",
          translation: " upraveno ",
          difficulty: 3,
          pronunciation: " up ",
        },
        {
          word: " new ",
          translation: " nové ",
          difficulty: 1,
        },
      ],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(setLookupWhere, { id: 10, userId });
  assert.deepEqual(wordUpdates, [
    {
      where: { id: 101 },
      data: {
        word: "updated",
        translation: "upraveno",
        difficulty: 3,
        pronunciation: "up",
      },
    },
  ]);
  assert.equal("imageId" in wordUpdates[0]!.data, false);
  assert.equal("audioId" in wordUpdates[0]!.data, false);
  assert.deepEqual(wordCreates, [
    {
      word: "new",
      translation: "nové",
      difficulty: 1,
      pronunciation: null,
      userId,
      flashcardSetId: 10,
    },
  ]);
  assert.deepEqual(deletedWordWhere, {
    id: { in: [102] },
    flashcardSetId: 10,
    userId,
  });
  assert.deepEqual(deletedImageWhere, { id: { in: [202] } });
  assert.deepEqual(deletedAudioWhere, { id: { in: [302] } });
  assert.deepEqual(operationOrder, [
    "word.update",
    "word.create",
    "word.deleteMany",
    "wordImage.deleteMany",
    "wordAudio.deleteMany",
    "flashcardSet.update",
  ]);
  assert.deepEqual(setUpdateData, {
    name: "Updated set",
    fromLanguage: "cs",
    toLanguage: "de",
    tags: ["Shared", "Fresh"],
  });
  assert.equal("isPublic" in setUpdateData!, false);
  assert.equal("publicCode" in setUpdateData!, false);
  const payload = response.json<{
    flashcardSet: { isPublic: boolean; publicCode: string | null };
  }>();
  assert.deepEqual(payload.flashcardSet, finalSet);
});

test("PATCH rejects a word ID outside the owned set", async (t) => {
  let mutated = false;
  const transaction = {
    flashcardSet: {
      findFirst: async () => ({
        id: 10,
        words: [{ id: 101, imageId: null, audioId: null }],
      }),
      update: async () => {
        mutated = true;
      },
    },
    word: {
      update: async () => {
        mutated = true;
      },
    },
  };
  const app = await buildApp({
    config,
    prisma: transactionalPrisma(transaction),
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "PATCH",
    url: "/api/v1/flashcard-sets/10",
    headers: jsonHeaders("foreign-word"),
    payload: {
      name: "Set",
      tags: [],
      words: [
        { id: 999, word: "word", translation: "překlad", difficulty: 1 },
      ],
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.json<{ error: { code: string } }>().error.code,
    "WORD_NOT_IN_FLASHCARD_SET",
  );
  assert.equal(mutated, false);
});

test("DELETE is owner-scoped and cleans media after deleting the set", async (t) => {
  const operationOrder: string[] = [];
  let lookupWhere: unknown;
  let deletedSetWhere: unknown;
  let deletedImageWhere: unknown;
  let deletedAudioWhere: unknown;
  const transaction = {
    flashcardSet: {
      findFirst: async (args: { where: unknown }) => {
        lookupWhere = args.where;
        return {
          id: 10,
          words: [
            { id: 101, imageId: 201, audioId: null },
            { id: 102, imageId: null, audioId: 302 },
          ],
        };
      },
      delete: async (args: { where: unknown }) => {
        operationOrder.push("flashcardSet.delete");
        deletedSetWhere = args.where;
        return { id: 10 };
      },
    },
    wordImage: {
      deleteMany: async (args: { where: unknown }) => {
        operationOrder.push("wordImage.deleteMany");
        deletedImageWhere = args.where;
        return { count: 1 };
      },
    },
    wordAudio: {
      deleteMany: async (args: { where: unknown }) => {
        operationOrder.push("wordAudio.deleteMany");
        deletedAudioWhere = args.where;
        return { count: 1 };
      },
    },
  };
  const app = await buildApp({
    config,
    prisma: transactionalPrisma(transaction),
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "DELETE",
    url: "/api/v1/flashcard-sets/10",
    headers: { cookie: authCookie, "x-request-id": "delete-set" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(lookupWhere, { id: 10, userId });
  assert.deepEqual(deletedSetWhere, { id: 10 });
  assert.deepEqual(deletedImageWhere, { id: { in: [201] } });
  assert.deepEqual(deletedAudioWhere, { id: { in: [302] } });
  assert.deepEqual(operationOrder, [
    "flashcardSet.delete",
    "wordImage.deleteMany",
    "wordAudio.deleteMany",
  ]);
});

test("DELETE returns 404 when the set is not owned", async (t) => {
  let lookupWhere: unknown;
  let deleted = false;
  const transaction = {
    flashcardSet: {
      findFirst: async (args: { where: unknown }) => {
        lookupWhere = args.where;
        return null;
      },
      delete: async () => {
        deleted = true;
      },
    },
  };
  const app = await buildApp({
    config,
    prisma: transactionalPrisma(transaction),
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "DELETE",
    url: "/api/v1/flashcard-sets/10",
    headers: { cookie: authCookie, "x-request-id": "delete-foreign-set" },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(
    response.json<{ error: { code: string } }>().error.code,
    "FLASHCARD_SET_NOT_FOUND",
  );
  assert.deepEqual(lookupWhere, { id: 10, userId });
  assert.equal(deleted, false);
});
