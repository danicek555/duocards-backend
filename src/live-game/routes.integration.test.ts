import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { createAuthToken } from "../lib/auth-token.js";
import { verifyLiveGameToken } from "./token.js";
import type { LiveGameSessionSnapshot } from "./contracts.js";

const userId = 42;
const userEmail = "host@example.test";
const passwordHash = "$argon2id$live-game-test-password-hash";
const sessionId = "11111111-1111-4111-8111-111111111111";
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

const authCookie = `auth=${createAuthToken(
  { userId, email: userEmail },
  config.authSecret,
  passwordHash,
)}`;

test("POST /live/sessions creates a server-owned lobby without leaking answers", async (t) => {
  let capturedCreateData: Record<string, unknown> | undefined;
  const createdAt = new Date("2026-07-21T12:00:00.000Z");
  const prisma = {
    user: {
      findUnique: async () => ({
        id: userId,
        email: userEmail,
        password: passwordHash,
      }),
    },
    flashcardSet: {
      findMany: async () => [
        {
          id: 5,
          words: [
            { word: "one", translation: "jedna" },
            { word: "two", translation: "dva" },
          ],
        },
      ],
    },
    liveSession: {
      findUnique: async (args: { where: { id?: string; roomCode?: string } }) => {
        if (args.where.roomCode) return null;
        if (args.where.id === sessionId) {
          return {
            id: sessionId,
            hostUserId: userId,
            roomCode: "ABC234",
            modeId: "classic_arena",
            modeVersion: 1,
            status: "LOBBY",
            sequence: 0,
            settings: {
              flashcardSetIds: [5],
              questionCount: 2,
              questionTimeSeconds: 20,
            },
            currentRoundId: null,
            startedAt: null,
            endedAt: null,
            expiresAt: new Date("2026-07-21T18:00:00.000Z"),
            createdAt,
            updatedAt: createdAt,
            participants: [],
          };
        }
        return null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        capturedCreateData = args.data;
        return { id: sessionId };
      },
    },
    liveRound: {
      findUnique: async () => null,
    },
  } as unknown as PrismaClient;

  const app = await buildApp({ config, prisma });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/live/sessions",
    headers: {
      cookie: authCookie,
      "content-type": "application/json",
      "x-request-id": "create-live-session",
    },
    payload: {
      modeId: "classic_arena",
      flashcardSetIds: [5],
      questionCount: 10,
      questionTimeSeconds: 20,
    },
  });

  assert.equal(response.statusCode, 201, response.body);
  assert.ok(capturedCreateData);
  assert.equal(capturedCreateData.hostUserId, userId);
  assert.equal(capturedCreateData.modeId, "classic_arena");
  const body = response.json<{
    session: LiveGameSessionSnapshot;
    hostToken: string;
  }>();
  assert.equal(body.session.contractVersion, 1);
  assert.equal(body.session.id, sessionId);
  assert.equal(body.session.roomCode, "ABC234");
  assert.equal(body.session.modeId, "classic_arena");
  assert.equal(body.session.status, "LOBBY");
  assert.equal(body.session.totalQuestions, 2);
  assert.equal(body.session.currentQuestion, null);
  assert.deepEqual(body.session.participants, []);
  assert.equal(body.session.viewer, null);
  assert.equal(new Date(body.session.serverTime).toISOString(), body.session.serverTime);
  assert.equal(response.body.includes("jedna"), false);
  assert.deepEqual(verifyLiveGameToken(body.hostToken, config.authSecret)?.role, "HOST");
});

test("live session creation requires the normal authenticated host cookie", async (t) => {
  const prisma = new Proxy({} as PrismaClient, {
    get(_target, property) {
      throw new Error(`Unexpected Prisma access: ${String(property)}`);
    },
  });
  const app = await buildApp({ config, prisma });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/live/sessions",
    headers: { "content-type": "application/json" },
    payload: {
      modeId: "classic_arena",
      flashcardSetIds: [5],
      questionCount: 10,
      questionTimeSeconds: 20,
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(
    response.json<{ error: { code: string } }>().error.code,
    "UNAUTHORIZED",
  );
});
