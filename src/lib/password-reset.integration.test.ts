import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { verifyPassword } from "./password.js";
import {
  FORGOT_PASSWORD_SUCCESS_MESSAGE,
  generatePasswordResetToken,
  hashPasswordResetToken,
  PASSWORD_RESET_TOKEN_TTL_MS,
  RESET_PASSWORD_SUCCESS_MESSAGE,
} from "./password-reset.js";
import type {
  PasswordResetEmailMessage,
  PasswordResetEmailSender,
} from "./password-reset-email.js";

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

interface UserRow {
  id: number;
  email: string;
  password: string;
}

interface ResetTokenRow {
  id: number;
  userId: number;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

interface MemoryOptions {
  users?: UserRow[];
  tokens?: ResetTokenRow[];
  failTokenCreate?: boolean;
  forceConsumeMiss?: boolean;
}

function tokenMatchesWhere(
  token: ResetTokenRow,
  where: Record<string, unknown>,
): boolean {
  for (const key of ["id", "userId", "tokenHash"] as const) {
    if (where[key] !== undefined && token[key] !== where[key]) return false;
  }
  const expiresAt = where.expiresAt;
  if (typeof expiresAt === "object" && expiresAt !== null) {
    if (
      "gt" in expiresAt &&
      expiresAt.gt instanceof Date &&
      token.expiresAt.getTime() <= expiresAt.gt.getTime()
    ) {
      return false;
    }
    if (
      "lte" in expiresAt &&
      expiresAt.lte instanceof Date &&
      token.expiresAt.getTime() > expiresAt.lte.getTime()
    ) {
      return false;
    }
  }
  return true;
}

function createMemoryPrisma(options: MemoryOptions = {}) {
  const users = [...(options.users ?? [])];
  const tokens = [...(options.tokens ?? [])];
  const stats = {
    userFinds: 0,
    userUpdates: 0,
    tokenCreates: 0,
    tokenFinds: 0,
  };
  const events: string[] = [];

  const user = {
    async findUnique(args: {
      where: { id?: number; email?: string };
    }) {
      stats.userFinds += 1;
      return (
        users.find((candidate) =>
          args.where.email !== undefined
            ? candidate.email === args.where.email
            : candidate.id === args.where.id,
        ) ?? null
      );
    },
    async update(args: {
      where: { id: number };
      data: { password: string };
    }) {
      events.push("user.update");
      const existing = users.find(({ id }) => id === args.where.id);
      if (!existing) {
        throw Object.assign(new Error("Record not found"), { code: "P2025" });
      }
      stats.userUpdates += 1;
      existing.password = args.data.password;
      return existing;
    },
  };
  const passwordResetToken = {
    async create(args: {
      data: Pick<ResetTokenRow, "userId" | "tokenHash" | "expiresAt">;
    }) {
      stats.tokenCreates += 1;
      if (options.failTokenCreate) throw new Error("database unavailable");
      const token: ResetTokenRow = {
        ...args.data,
        id: Math.max(0, ...tokens.map(({ id }) => id)) + 1,
        createdAt: new Date(),
      };
      tokens.push(token);
      return token;
    },
    async findFirst(args: {
      where: { tokenHash: { in: string[] } };
    }) {
      stats.tokenFinds += 1;
      return (
        tokens.find((token) =>
          args.where.tokenHash.in.includes(token.tokenHash),
        ) ?? null
      );
    },
    async deleteMany(args: { where: Record<string, unknown> }) {
      const isConsume =
        typeof args.where.expiresAt === "object" &&
        args.where.expiresAt !== null &&
        "gt" in args.where.expiresAt;
      if (isConsume) events.push("token.consume");
      if (isConsume && options.forceConsumeMiss) return { count: 0 };

      let count = 0;
      for (let index = tokens.length - 1; index >= 0; index -= 1) {
        if (tokenMatchesWhere(tokens[index]!, args.where)) {
          tokens.splice(index, 1);
          count += 1;
        }
      }
      if (!isConsume && args.where.userId !== undefined) {
        events.push("token.invalidate-all");
      }
      return { count };
    },
  };
  const transactionClient = {
    user,
    passwordResetToken,
    async $queryRaw<T>(
      query: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<T> {
      assert.match(query.join("?"), /FROM "users"[\s\S]*FOR UPDATE/u);
      const userId = values[0];
      const locked = users.some(({ id }) => id === userId)
        ? [{ id: userId }]
        : [];
      return locked as T;
    },
    async $executeRaw(
      query: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<number> {
      assert.match(
        query.join("?"),
        /DELETE FROM "password_reset_tokens"/u,
      );
      events.push("token.consume");
      if (options.forceConsumeMiss) return 0;

      const [id, userId, tokenHash] = values;
      const index = tokens.findIndex(
        (token) =>
          token.id === id &&
          token.userId === userId &&
          token.tokenHash === tokenHash &&
          token.expiresAt > new Date(),
      );
      if (index === -1) return 0;
      tokens.splice(index, 1);
      return 1;
    },
  };
  const rawClient = {
    ...transactionClient,
    async $transaction<T>(
      callback: (transaction: typeof transactionClient) => Promise<T>,
    ): Promise<T> {
      return callback(transactionClient);
    },
  };

  return {
    client: rawClient as unknown as PrismaClient,
    users,
    tokens,
    stats,
    events,
  };
}

class CapturingPasswordResetEmailSender
  implements PasswordResetEmailSender
{
  readonly messages: PasswordResetEmailMessage[] = [];

  constructor(private readonly failure: Error | null = null) {}

  async sendPasswordReset(
    message: PasswordResetEmailMessage,
  ): Promise<void> {
    this.messages.push(message);
    if (this.failure) throw this.failure;
  }
}

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: overrides.id ?? 1,
    email: overrides.email ?? "user@example.com",
    password: overrides.password ?? "$argon2id$old-password-hash",
  };
}

function makeToken(
  rawToken: string,
  overrides: Partial<ResetTokenRow> = {},
): ResetTokenRow {
  return {
    id: overrides.id ?? 1,
    userId: overrides.userId ?? 1,
    tokenHash:
      overrides.tokenHash ??
      hashPasswordResetToken(rawToken, config.authSecret),
    expiresAt:
      overrides.expiresAt ??
      new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
    createdAt: overrides.createdAt ?? new Date(),
  };
}

function setCookieLines(response: {
  headers: Record<string, unknown>;
}): string[] {
  const value = response.headers["set-cookie"];
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? [value] : [];
}

test("forgot password has one response and stores only an HMAC token", async (t) => {
  const previousToken = makeToken(generatePasswordResetToken(), { id: 4 });
  const memory = createMemoryPrisma({
    users: [makeUser()],
    tokens: [previousToken],
  });
  const sender = new CapturingPasswordResetEmailSender();
  const app = await buildApp({
    config,
    prisma: memory.client,
    passwordResetEmailSender: sender,
  });
  t.after(async () => app.close());

  const unknown = await app.inject({
    method: "POST",
    url: "/api/v1/auth/forgot-password",
    payload: { email: "unknown@example.com" },
  });
  const startedAt = Date.now();
  const existing = await app.inject({
    method: "POST",
    url: "/api/v1/auth/forgot-password",
    payload: { email: " USER@Example.COM " },
  });

  const expectedBody = { message: FORGOT_PASSWORD_SUCCESS_MESSAGE };
  assert.equal(unknown.statusCode, 200);
  assert.equal(existing.statusCode, 200);
  assert.deepEqual(unknown.json(), expectedBody);
  assert.deepEqual(existing.json(), expectedBody);
  assert.equal(sender.messages.length, 1);
  assert.equal(memory.tokens.length, 2, "older active tokens stay valid");

  const message = sender.messages[0]!;
  const created = memory.tokens.find(({ id }) => id !== previousToken.id)!;
  assert.equal(message.to, "user@example.com");
  assert.match(message.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(
    created.tokenHash,
    hashPasswordResetToken(message.token, config.authSecret),
  );
  assert.notEqual(created.tokenHash, message.token);
  assert.ok(
    created.expiresAt.getTime() >= startedAt + PASSWORD_RESET_TOKEN_TTL_MS,
  );
  assert.ok(
    created.expiresAt.getTime() <= Date.now() + PASSWORD_RESET_TOKEN_TTL_MS,
  );
  assert.equal(existing.body.includes(message.token), false);
});

test("forgot delivery failure rolls back only the newly-created token", async (t) => {
  const previousToken = makeToken(generatePasswordResetToken(), { id: 8 });
  const memory = createMemoryPrisma({
    users: [makeUser()],
    tokens: [previousToken],
  });
  const sender = new CapturingPasswordResetEmailSender(
    new Error("provider unavailable"),
  );
  const app = await buildApp({
    config,
    prisma: memory.client,
    passwordResetEmailSender: sender,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/forgot-password",
    payload: { email: "user@example.com" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    message: FORGOT_PASSWORD_SUCCESS_MESSAGE,
  });
  assert.equal(sender.messages.length, 1);
  assert.deepEqual(memory.tokens, [previousToken]);
});

test("forgot operational failures keep the same public response", async (t) => {
  const memory = createMemoryPrisma({
    users: [makeUser()],
    failTokenCreate: true,
  });
  const sender = new CapturingPasswordResetEmailSender();
  const app = await buildApp({
    config,
    prisma: memory.client,
    passwordResetEmailSender: sender,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/forgot-password",
    headers: { "x-request-id": "forgot-db-failure" },
    payload: { email: "user@example.com" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    message: FORGOT_PASSWORD_SUCCESS_MESSAGE,
  });
  assert.equal(sender.messages.length, 0);
  assert.equal(response.body.includes("database"), false);
});

test("forgot email bucket is isolated by caller IP", async (t) => {
  const memory = createMemoryPrisma({ users: [makeUser()] });
  const sender = new CapturingPasswordResetEmailSender();
  const app = await buildApp({
    config,
    prisma: memory.client,
    passwordResetEmailSender: sender,
  });
  t.after(async () => app.close());

  for (let index = 0; index < 5; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      remoteAddress: "198.51.100.10",
      payload: { email: "user@example.com" },
    });
    assert.equal(response.statusCode, 200);
  }
  const attackerLimited = await app.inject({
    method: "POST",
    url: "/api/v1/auth/forgot-password",
    remoteAddress: "198.51.100.10",
    payload: { email: "user@example.com" },
  });
  const differentIp = await app.inject({
    method: "POST",
    url: "/api/v1/auth/forgot-password",
    remoteAddress: "203.0.113.20",
    payload: { email: "user@example.com" },
  });

  assert.equal(attackerLimited.statusCode, 200);
  assert.deepEqual(attackerLimited.json(), differentIp.json());
  assert.ok(Number(attackerLimited.headers["retry-after"]) > 0);
  assert.equal(differentIp.headers["retry-after"], undefined);
  assert.equal(sender.messages.length, 6);
});

test("forgot IP limit is silent and stops work after twenty requests", async (t) => {
  const memory = createMemoryPrisma();
  const sender = new CapturingPasswordResetEmailSender();
  const app = await buildApp({
    config,
    prisma: memory.client,
    passwordResetEmailSender: sender,
  });
  t.after(async () => app.close());

  for (let index = 0; index < 20; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      remoteAddress: "198.51.100.30",
      payload: { email: `unknown-${index}@example.com` },
    });
    assert.equal(response.statusCode, 200);
  }
  const limited = await app.inject({
    method: "POST",
    url: "/api/v1/auth/forgot-password",
    remoteAddress: "198.51.100.30",
    payload: { email: "unknown-final@example.com" },
  });

  assert.equal(limited.statusCode, 200);
  assert.deepEqual(limited.json(), {
    message: FORGOT_PASSWORD_SUCCESS_MESSAGE,
  });
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(memory.stats.userFinds, 20);
});

test("reset atomically changes the password, invalidates tokens, and clears auth", async (t) => {
  const rawToken = generatePasswordResetToken();
  const otherForUser = makeToken(generatePasswordResetToken(), { id: 2 });
  const otherUserToken = makeToken(generatePasswordResetToken(), {
    id: 3,
    userId: 2,
  });
  const memory = createMemoryPrisma({
    users: [makeUser(), makeUser({ id: 2, email: "other@example.com" })],
    tokens: [makeToken(rawToken), otherForUser, otherUserToken],
  });
  const app = await buildApp({
    config,
    prisma: memory.client,
    passwordResetEmailSender: new CapturingPasswordResetEmailSender(),
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/reset-password",
    headers: { cookie: "auth=old-session" },
    payload: { token: rawToken, password: "NewStrong1!" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { message: RESET_PASSWORD_SUCCESS_MESSAGE });
  assert.equal(
    await verifyPassword("NewStrong1!", memory.users[0]!.password),
    true,
  );
  assert.deepEqual(memory.tokens, [otherUserToken]);
  assert.deepEqual(memory.events, [
    "token.consume",
    "user.update",
    "token.invalidate-all",
  ]);
  assert.equal(memory.stats.userUpdates, 1);
  const clearedAuth = setCookieLines(response).find((line) =>
    line.startsWith("auth=;"),
  );
  assert.ok(clearedAuth);
  assert.match(clearedAuth, /Path=\//u);

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/auth/reset-password",
    payload: { token: rawToken, password: "AnotherStrong1!" },
  });
  assert.equal(replay.statusCode, 400);
  assert.equal(
    replay.json().error.code,
    "INVALID_OR_EXPIRED_RESET_TOKEN",
  );
  assert.equal(memory.stats.userUpdates, 1);
});

test("reset accepts a still-active legacy SHA-256 cutover token", async (t) => {
  const legacyToken = "a".repeat(64);
  const memory = createMemoryPrisma({
    users: [makeUser()],
    tokens: [
      makeToken(legacyToken, {
        tokenHash: createHash("sha256").update(legacyToken).digest("hex"),
      }),
    ],
  });
  const app = await buildApp({
    config,
    prisma: memory.client,
    passwordResetEmailSender: new CapturingPasswordResetEmailSender(),
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/reset-password",
    payload: { token: legacyToken, password: "LegacyStrong1!" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    await verifyPassword("LegacyStrong1!", memory.users[0]!.password),
    true,
  );
});

test("reset rejects weak, missing, expired, and concurrently consumed tokens", async (t) => {
  const validToken = generatePasswordResetToken();
  const expiredToken = generatePasswordResetToken();
  const memory = createMemoryPrisma({
    users: [makeUser()],
    tokens: [
      makeToken(validToken),
      makeToken(expiredToken, {
        id: 2,
        expiresAt: new Date(Date.now() - 1),
      }),
    ],
    forceConsumeMiss: true,
  });
  const app = await buildApp({
    config,
    prisma: memory.client,
    passwordResetEmailSender: new CapturingPasswordResetEmailSender(),
  });
  t.after(async () => app.close());

  const weak = await app.inject({
    method: "POST",
    url: "/api/v1/auth/reset-password",
    payload: { token: validToken, password: "Strong12" },
  });
  const missing = await app.inject({
    method: "POST",
    url: "/api/v1/auth/reset-password",
    payload: {
      token: generatePasswordResetToken(),
      password: "NewStrong1!",
    },
  });
  const expired = await app.inject({
    method: "POST",
    url: "/api/v1/auth/reset-password",
    payload: { token: expiredToken, password: "NewStrong1!" },
  });
  const consumed = await app.inject({
    method: "POST",
    url: "/api/v1/auth/reset-password",
    payload: { token: validToken, password: "NewStrong1!" },
  });

  assert.equal(weak.statusCode, 400);
  assert.equal(weak.json().error.code, "PASSWORD_MEDIUM");
  for (const response of [missing, expired, consumed]) {
    assert.equal(response.statusCode, 400);
    assert.equal(
      response.json().error.code,
      "INVALID_OR_EXPIRED_RESET_TOKEN",
    );
  }
  assert.equal(memory.stats.userUpdates, 0);
  assert.equal(
    memory.tokens.some(({ tokenHash }) =>
      tokenHash === hashPasswordResetToken(expiredToken, config.authSecret),
    ),
    false,
  );
});

test("reset token and global IP limits return shared 429 envelopes", async (t) => {
  const memory = createMemoryPrisma();
  const app = await buildApp({
    config,
    prisma: memory.client,
    passwordResetEmailSender: new CapturingPasswordResetEmailSender(),
  });
  t.after(async () => app.close());
  const repeatedToken = generatePasswordResetToken();

  for (let index = 0; index < 5; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      remoteAddress: "198.51.100.40",
      payload: { token: repeatedToken, password: "NewStrong1!" },
    });
    assert.equal(response.statusCode, 400);
  }
  const tokenLimited = await app.inject({
    method: "POST",
    url: "/api/v1/auth/reset-password",
    remoteAddress: "198.51.100.40",
    headers: { "x-request-id": "reset-token-limit" },
    payload: { token: repeatedToken, password: "NewStrong1!" },
  });
  assert.equal(tokenLimited.statusCode, 429);
  assert.equal(
    tokenLimited.json().error.code,
    "RATE_LIMIT_RESET_PASSWORD",
  );
  assert.equal(tokenLimited.json().requestId, "reset-token-limit");
  assert.ok(Number(tokenLimited.headers["retry-after"]) > 0);

  for (let index = 0; index < 20; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      remoteAddress: "203.0.113.50",
      payload: {
        token: generatePasswordResetToken(),
        password: "NewStrong1!",
      },
    });
    assert.equal(response.statusCode, 400);
  }
  const ipLimited = await app.inject({
    method: "POST",
    url: "/api/v1/auth/reset-password",
    remoteAddress: "203.0.113.50",
    headers: { "x-request-id": "reset-ip-limit" },
    payload: {
      token: generatePasswordResetToken(),
      password: "NewStrong1!",
    },
  });
  assert.equal(ipLimited.statusCode, 429);
  assert.equal(ipLimited.json().error.code, "RATE_LIMIT_RESET_PASSWORD");
  assert.equal(ipLimited.json().requestId, "reset-ip-limit");
  assert.equal(ipLimited.headers["x-ratelimit-remaining"], "0");
});
