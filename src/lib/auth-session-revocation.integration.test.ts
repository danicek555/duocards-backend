import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { hashPassword } from "./password.js";
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
} from "./password-reset.js";

const config = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 4000,
  logLevel: "silent",
  trustProxy: false,
  databaseUrl: "postgresql://unused.test/duocards",
  authSecret: "test-secret-with-at-least-thirty-two-bytes",
  corsOrigins: [],
  cookieSecure: false,
  verificationEmailMode: "resend",
  resendApiKey: null,
  emailFrom: "DuoCards <notifications@example.test>",
  publicAppUrl: "https://app.example.test",
} satisfies AppConfig;

interface MemoryUser {
  id: number;
  email: string;
  password: string;
  nickname: string;
  locale: string;
  emailVerified: boolean;
  createdAt: Date;
}

interface MemoryResetToken {
  id: number;
  userId: number;
  tokenHash: string;
  expiresAt: Date;
}

function createMemoryPrisma(
  user: MemoryUser,
  initialResetToken: MemoryResetToken,
): PrismaClient {
  let resetToken: MemoryResetToken | null = initialResetToken;

  const userDelegate = {
    async findUnique(args: {
      where: { id?: number; email?: string };
    }) {
      const matches =
        args.where.id === user.id || args.where.email === user.email;
      return matches ? user : null;
    },
    async update(args: {
      where: { id: number };
      data: { password: string };
    }) {
      if (args.where.id !== user.id) {
        throw Object.assign(new Error("User not found"), { code: "P2025" });
      }
      user.password = args.data.password;
      return user;
    },
  };

  const resetTokenDelegate = {
    async findFirst(args: {
      where: { tokenHash: { in: string[] } };
    }) {
      return resetToken &&
        args.where.tokenHash.in.includes(resetToken.tokenHash)
        ? resetToken
        : null;
    },
    async deleteMany(args: {
      where: {
        id?: number;
        userId?: number;
        tokenHash?: string;
        expiresAt?: { gt?: Date; lte?: Date };
      };
    }) {
      if (!resetToken) return { count: 0 };
      const where = args.where;
      const matches =
        (where.id === undefined || where.id === resetToken.id) &&
        (where.userId === undefined || where.userId === resetToken.userId) &&
        (where.tokenHash === undefined ||
          where.tokenHash === resetToken.tokenHash) &&
        (where.expiresAt?.gt === undefined ||
          resetToken.expiresAt > where.expiresAt.gt) &&
        (where.expiresAt?.lte === undefined ||
          resetToken.expiresAt <= where.expiresAt.lte);
      if (!matches) return { count: 0 };
      resetToken = null;
      return { count: 1 };
    },
  };

  const transactionClient = {
    user: userDelegate,
    passwordResetToken: resetTokenDelegate,
    async $queryRaw<T>(
      query: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<T> {
      assert.match(query.join("?"), /FROM "users"[\s\S]*FOR UPDATE/u);
      return (values[0] === user.id ? [{ id: user.id }] : []) as T;
    },
    async $executeRaw(
      query: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<number> {
      assert.match(
        query.join("?"),
        /DELETE FROM "password_reset_tokens"/u,
      );
      if (!resetToken) return 0;
      const [id, userId, tokenHash] = values;
      const matches =
        resetToken.id === id &&
        resetToken.userId === userId &&
        resetToken.tokenHash === tokenHash &&
        resetToken.expiresAt > new Date();
      if (!matches) return 0;
      resetToken = null;
      return 1;
    },
  };
  return {
    ...transactionClient,
    async $transaction<T>(
      callback: (transaction: typeof transactionClient) => Promise<T>,
    ): Promise<T> {
      return callback(transactionClient);
    },
  } as unknown as PrismaClient;
}

function authCookie(response: {
  headers: Record<string, string | string[] | number | undefined>;
}): string {
  const raw = response.headers["set-cookie"];
  const lines = Array.isArray(raw)
    ? raw
    : raw === undefined
      ? []
      : [String(raw)];
  const auth = lines.find((line) => line.startsWith("auth="));
  assert.ok(auth);
  return auth.split(";", 1)[0]!;
}

test("password reset revokes old credential-version sessions", async (t) => {
  const oldPassword = "OldStrong1!";
  const newPassword = "NewStrong1!";
  const rawResetToken = generatePasswordResetToken();
  const user: MemoryUser = {
    id: 7,
    email: "user@example.test",
    password: await hashPassword(oldPassword),
    nickname: "Ada",
    locale: "en",
    emailVerified: true,
    createdAt: new Date("2026-07-15T10:00:00.000Z"),
  };
  const prisma = createMemoryPrisma(user, {
    id: 11,
    userId: user.id,
    tokenHash: hashPasswordResetToken(rawResetToken, config.authSecret),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const app = await buildApp({ config, prisma });
  t.after(async () => app.close());

  const oldLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: user.email, password: oldPassword },
  });
  assert.equal(oldLogin.statusCode, 200);
  const oldCookie = authCookie(oldLogin);

  const beforeReset = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: oldCookie },
  });
  assert.equal(beforeReset.statusCode, 200);

  const reset = await app.inject({
    method: "POST",
    url: "/api/v1/auth/reset-password",
    payload: { token: rawResetToken, password: newPassword },
  });
  assert.equal(reset.statusCode, 200);

  const staleSession = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: oldCookie, "x-request-id": "stale-session" },
  });
  assert.equal(staleSession.statusCode, 401);
  assert.deepEqual(staleSession.json(), {
    error: { code: "UNAUTHORIZED", message: "Unauthorized" },
    requestId: "stale-session",
  });

  const newLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: user.email, password: newPassword },
  });
  assert.equal(newLogin.statusCode, 200);

  const newSession = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: authCookie(newLogin) },
  });
  assert.equal(newSession.statusCode, 200);
  assert.equal(newSession.json().user.email, user.email);
});
