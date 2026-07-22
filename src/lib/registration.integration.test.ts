import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import {
  generateRegistrationToken,
  hashRegistrationToken,
  hashVerificationCode,
  REGISTRATION_COOKIE_NAME,
  VERIFICATION_CODE_TTL_MS,
  verificationCodeMatches,
} from "./registration.js";
import type {
  VerificationEmailMessage,
  VerificationEmailSender,
} from "./verification-email.js";

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

interface AttemptRow {
  id: number;
  tokenHash: string;
  email: string;
  password: string;
  nickname: string;
  locale: string;
  codeHash: string;
  expiresAt: Date;
  createdAt: Date;
}

interface UserRow {
  id: number;
  email: string;
  password: string;
  nickname: string;
  locale: string;
  emailVerified: boolean;
  createdAt: Date;
}

interface MemoryOptions {
  attempts?: AttemptRow[];
  users?: UserRow[];
  forceUserCreateConflict?: boolean;
  forceAttemptUpdateMiss?: boolean;
}

function matchesAttemptWhere(
  attempt: AttemptRow,
  where: Record<string, unknown>,
): boolean {
  return ["id", "tokenHash", "email", "codeHash"].every((key) =>
    where[key] === undefined
      ? true
      : attempt[key as keyof AttemptRow] === where[key],
  );
}

function createMemoryPrisma(options: MemoryOptions = {}) {
  const attempts = [...(options.attempts ?? [])];
  const users = [...(options.users ?? [])];
  const stats = {
    attemptCreates: 0,
    attemptFinds: 0,
    attemptUpdates: 0,
    userFinds: 0,
    userCreates: 0,
    coinTransactionCreates: 0,
  };

  const user = {
    async findUnique(args: {
      where: { id?: number; email?: string };
    }) {
      stats.userFinds += 1;
      return (
        users.find((user) =>
          args.where.email !== undefined
            ? user.email === args.where.email
            : user.id === args.where.id,
        ) ?? null
      );
    },
    async create(args: {
      data: Omit<UserRow, "id" | "createdAt">;
    }) {
      stats.userCreates += 1;
      if (
        options.forceUserCreateConflict ||
        users.some((user) => user.email === args.data.email)
      ) {
        throw Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
        });
      }
      const user: UserRow = {
        ...args.data,
        id: Math.max(0, ...users.map(({ id }) => id)) + 1,
        createdAt: new Date(),
      };
      users.push(user);
      return user;
    },
  };
  const registrationAttempt = {
    async create(args: {
      data: Omit<AttemptRow, "id" | "createdAt">;
    }) {
      stats.attemptCreates += 1;
      const attempt: AttemptRow = {
        ...args.data,
        id: Math.max(0, ...attempts.map(({ id }) => id)) + 1,
        createdAt: new Date(),
      };
      attempts.push(attempt);
      return attempt;
    },
    async findUnique(args: { where: { tokenHash: string } }) {
      stats.attemptFinds += 1;
      return (
        attempts.find(
          (attempt) => attempt.tokenHash === args.where.tokenHash,
        ) ?? null
      );
    },
    async deleteMany(args: { where: Record<string, unknown> }) {
      let count = 0;
      for (let index = attempts.length - 1; index >= 0; index -= 1) {
        const attempt = attempts[index]!;
        if (matchesAttemptWhere(attempt, args.where)) {
          attempts.splice(index, 1);
          count += 1;
        }
      }
      return { count };
    },
    async updateMany(args: {
      where: Record<string, unknown>;
      data: Pick<AttemptRow, "codeHash" | "expiresAt">;
    }) {
      stats.attemptUpdates += 1;
      if (options.forceAttemptUpdateMiss) return { count: 0 };
      const attempt = attempts.find((candidate) =>
        matchesAttemptWhere(candidate, args.where),
      );
      if (!attempt) return { count: 0 };
      attempt.codeHash = args.data.codeHash;
      attempt.expiresAt = args.data.expiresAt;
      return { count: 1 };
    },
  };
  const coinTransactions: Array<{
    userId: number;
    amount: number;
    balanceAfter: number;
    type: string;
  }> = [];
  const coinTransaction = {
    async create(args: { data: (typeof coinTransactions)[number] }) {
      stats.coinTransactionCreates += 1;
      coinTransactions.push(args.data);
      return { id: coinTransactions.length, ...args.data };
    },
  };
  const transactionClient = { user, registrationAttempt, coinTransaction };
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
    attempts,
    users,
    coinTransactions,
    stats,
  };
}

class CapturingEmailSender implements VerificationEmailSender {
  readonly messages: VerificationEmailMessage[] = [];

  constructor(private readonly failure: Error | null = null) {}

  async sendVerificationCode(
    message: VerificationEmailMessage,
  ): Promise<void> {
    this.messages.push(message);
    if (this.failure) throw this.failure;
  }
}

function makeAttempt(
  overrides: Partial<AttemptRow> & {
    token: string;
    code: string;
  },
): AttemptRow {
  const email = overrides.email ?? "user@example.com";
  return {
    id: overrides.id ?? 1,
    tokenHash: hashRegistrationToken(overrides.token, config.authSecret),
    email,
    password: overrides.password ?? "$argon2id$test-hash",
    nickname: overrides.nickname ?? "Ada",
    locale: overrides.locale ?? "en",
    codeHash:
      overrides.codeHash ??
      hashVerificationCode(email, overrides.code, config.authSecret),
    expiresAt:
      overrides.expiresAt ?? new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
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

function findSetCookie(
  response: { headers: Record<string, unknown> },
  name: string,
): string | undefined {
  return setCookieLines(response).find((line) =>
    line.startsWith(`${name}=`),
  );
}

function cookieValue(line: string, name: string): string {
  const pair = line.split(";", 1)[0]!;
  assert.ok(pair.startsWith(`${name}=`));
  return pair.slice(name.length + 1);
}

test("register stores an independent HMAC-bound attempt and raw cookie", async (t) => {
  const memory = createMemoryPrisma();
  const sender = new CapturingEmailSender();
  const app = await buildApp({
    config: { ...config, cookieSecure: true },
    prisma: memory.client,
    emailSender: sender,
  });
  t.after(async () => app.close());

  const startedAt = Date.now();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email: " USER@Example.COM ",
      password: "Strong1!",
      nickname: " Ada ",
      locale: "EN_us",
    },
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), {
    message:
      "Registration successful! Please check your email for a verification code.",
    email: "user@example.com",
    requiresVerification: true,
  });
  assert.equal(memory.attempts.length, 1);
  assert.equal(sender.messages.length, 1);

  const attempt = memory.attempts[0]!;
  const message = sender.messages[0]!;
  const cookie = findSetCookie(response, REGISTRATION_COOKIE_NAME);
  assert.ok(cookie);
  const cookieMaxAge = Number(/Max-Age=(\d+)/u.exec(cookie)?.[1]);
  assert.ok(cookieMaxAge > 0 && cookieMaxAge <= 600);
  assert.match(cookie, /Path=\//u);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.match(cookie, /SameSite=Lax/u);
  const rawToken = cookieValue(cookie, REGISTRATION_COOKIE_NAME);

  assert.equal(
    attempt.tokenHash,
    hashRegistrationToken(rawToken, config.authSecret),
  );
  assert.notEqual(attempt.tokenHash, rawToken);
  assert.match(attempt.password, /^\$argon2id\$/u);
  assert.equal(attempt.email, "user@example.com");
  assert.equal(attempt.nickname, "Ada");
  assert.equal(attempt.locale, "en");
  assert.equal(message.to, attempt.email);
  assert.equal(
    verificationCodeMatches(
      attempt.codeHash,
      message.code,
      attempt.email,
      config.authSecret,
    ),
    true,
  );
  assert.ok(
    attempt.expiresAt.getTime() >= startedAt + VERIFICATION_CODE_TTL_MS,
  );
  assert.ok(
    attempt.expiresAt.getTime() <= Date.now() + VERIFICATION_CODE_TTL_MS,
  );
  assert.equal(response.body.includes(message.code), false);
  assert.equal(response.body.includes(rawToken), false);
});

test("register delivery failure deletes exactly its attempt and clears the cookie", async (t) => {
  const memory = createMemoryPrisma();
  const sender = new CapturingEmailSender(new Error("provider unavailable"));
  const app = await buildApp({
    config,
    prisma: memory.client,
    emailSender: sender,
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { "x-request-id": "register-delivery-failure" },
    payload: {
      email: "user@example.com",
      password: "Strong1!",
      nickname: "Ada",
      locale: "en",
    },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "EMAIL_DELIVERY_UNAVAILABLE");
  assert.equal(response.json().requestId, "register-delivery-failure");
  assert.equal(memory.attempts.length, 0);
  const cleared = findSetCookie(response, REGISTRATION_COOKIE_NAME);
  assert.ok(cleared);
  assert.ok(cleared.startsWith(`${REGISTRATION_COOKIE_NAME}=;`));
  assert.match(cleared, /Path=\//u);
});

test("verify creates a new user, removes every email attempt, and swaps cookies", async (t) => {
  const token = generateRegistrationToken();
  const code = "123456";
  const memory = createMemoryPrisma({
    attempts: [
      makeAttempt({ id: 1, token, code }),
      makeAttempt({
        id: 2,
        token: generateRegistrationToken(),
        code: "654321",
      }),
    ],
  });
  const app = await buildApp({
    config,
    prisma: memory.client,
    emailSender: new CapturingEmailSender(),
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    headers: { cookie: `${REGISTRATION_COOKIE_NAME}=${token}` },
    payload: { email: "USER@example.com", code },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(memory.stats.userCreates, 1);
  assert.equal(memory.stats.coinTransactionCreates, 1);
  assert.deepEqual(memory.coinTransactions, [
    {
      userId: memory.users[0]!.id,
      amount: 100,
      balanceAfter: 100,
      type: "WELCOME_BONUS",
    },
  ]);
  assert.equal(memory.users.length, 1);
  assert.equal(memory.users[0]!.emailVerified, true);
  assert.equal(memory.attempts.length, 0);
  const authCookie = findSetCookie(response, "auth");
  assert.ok(authCookie);
  assert.notEqual(cookieValue(authCookie, "auth"), "");
  const cleared = findSetCookie(response, REGISTRATION_COOKIE_NAME);
  assert.ok(cleared);
  assert.ok(cleared.startsWith(`${REGISTRATION_COOKIE_NAME}=;`));
  assert.match(cleared, /Path=\//u);
});

test("verify maps an existing-user conflict to 409 and never issues auth", async (t) => {
  const token = generateRegistrationToken();
  const code = "123456";
  const memory = createMemoryPrisma({
    attempts: [makeAttempt({ token, code })],
    users: [
      {
        id: 99,
        email: "user@example.com",
        password: "$argon2id$existing",
        nickname: "Existing",
        locale: "en",
        emailVerified: true,
        createdAt: new Date(),
      },
    ],
  });
  const app = await buildApp({
    config,
    prisma: memory.client,
    emailSender: new CapturingEmailSender(),
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    headers: {
      cookie: `${REGISTRATION_COOKIE_NAME}=${token}`,
      "x-request-id": "verify-conflict",
    },
    payload: { email: "user@example.com", code },
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: {
      code: "EMAIL_EXISTS",
      message: "User with this email already exists",
    },
    requestId: "verify-conflict",
  });
  assert.equal(memory.stats.userCreates, 1);
  assert.equal(findSetCookie(response, "auth"), undefined);
});

test("verify requires the exact token and rejects plaintext legacy codes", async (t) => {
  const token = generateRegistrationToken();
  const code = "123456";
  const memory = createMemoryPrisma({
    attempts: [makeAttempt({ token, code, codeHash: code })],
  });
  const app = await buildApp({
    config,
    prisma: memory.client,
    emailSender: new CapturingEmailSender(),
  });
  t.after(async () => app.close());

  const missingCookie = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    payload: { email: "user@example.com", code },
  });
  const wrongCookie = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    headers: {
      cookie: `${REGISTRATION_COOKIE_NAME}=${generateRegistrationToken()}`,
    },
    payload: { email: "user@example.com", code },
  });
  const legacyCode = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    headers: { cookie: `${REGISTRATION_COOKIE_NAME}=${token}` },
    payload: { email: "user@example.com", code },
  });

  assert.equal(missingCookie.statusCode, 400);
  assert.equal(wrongCookie.statusCode, 400);
  assert.equal(
    missingCookie.json().error.code,
    "INVALID_REGISTRATION_CHALLENGE",
  );
  assert.equal(
    wrongCookie.json().error.code,
    "INVALID_REGISTRATION_CHALLENGE",
  );
  assert.equal(legacyCode.statusCode, 400);
  assert.equal(legacyCode.json().error.code, "INVALID_VERIFICATION_CODE");
  assert.equal(memory.stats.userCreates, 0);
});

test("verify enforces exact expiry and removes the expired attempt", async (t) => {
  const token = generateRegistrationToken();
  const memory = createMemoryPrisma({
    attempts: [
      makeAttempt({
        token,
        code: "123456",
        expiresAt: new Date(Date.now() - 1),
      }),
    ],
  });
  const app = await buildApp({
    config,
    prisma: memory.client,
    emailSender: new CapturingEmailSender(),
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    headers: { cookie: `${REGISTRATION_COOKIE_NAME}=${token}` },
    payload: { email: "user@example.com", code: "123456" },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "VERIFICATION_CODE_EXPIRED");
  assert.equal(memory.attempts.length, 0);
  assert.equal(memory.stats.userCreates, 0);
});

test("resend is enumeration-safe, sends before rotation, and refreshes binding TTL", async (t) => {
  const token = generateRegistrationToken();
  const attempt = makeAttempt({ token, code: "123456" });
  const previousCodeHash = attempt.codeHash;
  const previousExpiry = attempt.expiresAt;
  const memory = createMemoryPrisma({ attempts: [attempt] });
  const sender = new CapturingEmailSender();
  const app = await buildApp({ config, prisma: memory.client, emailSender: sender });
  t.after(async () => app.close());

  const missing = await app.inject({
    method: "POST",
    url: "/api/v1/auth/resend",
    payload: { email: "user@example.com" },
  });
  const wrong = await app.inject({
    method: "POST",
    url: "/api/v1/auth/resend",
    headers: {
      cookie: `${REGISTRATION_COOKIE_NAME}=${generateRegistrationToken()}`,
    },
    payload: { email: "user@example.com" },
  });
  const valid = await app.inject({
    method: "POST",
    url: "/api/v1/auth/resend",
    headers: { cookie: `${REGISTRATION_COOKIE_NAME}=${token}` },
    payload: { email: "USER@example.com" },
  });

  assert.equal(missing.statusCode, 200);
  assert.equal(wrong.statusCode, 200);
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(missing.json(), wrong.json());
  assert.deepEqual(wrong.json(), valid.json());
  assert.equal(sender.messages.length, 1);
  assert.equal(memory.stats.attemptUpdates, 1);
  assert.notEqual(attempt.codeHash, previousCodeHash);
  assert.ok(attempt.expiresAt.getTime() > previousExpiry.getTime());
  assert.equal(
    verificationCodeMatches(
      attempt.codeHash,
      sender.messages[0]!.code,
      attempt.email,
      config.authSecret,
    ),
    true,
  );
  const refreshed = findSetCookie(valid, REGISTRATION_COOKIE_NAME);
  assert.ok(refreshed);
  const refreshedMaxAge = Number(/Max-Age=(\d+)/u.exec(refreshed)?.[1]);
  assert.ok(refreshedMaxAge > 0 && refreshedMaxAge <= 600);
  assert.match(refreshed, /Path=\//u);
});

test("resend delivery failure preserves the previous code and expiry", async (t) => {
  const token = generateRegistrationToken();
  const attempt = makeAttempt({ token, code: "123456" });
  const previousCodeHash = attempt.codeHash;
  const previousExpiry = attempt.expiresAt.getTime();
  const memory = createMemoryPrisma({ attempts: [attempt] });
  const sender = new CapturingEmailSender(new Error("provider unavailable"));
  const app = await buildApp({ config, prisma: memory.client, emailSender: sender });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/resend",
    headers: { cookie: `${REGISTRATION_COOKIE_NAME}=${token}` },
    payload: { email: "user@example.com" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(sender.messages.length, 1);
  assert.equal(memory.stats.attemptUpdates, 0);
  assert.equal(attempt.codeHash, previousCodeHash);
  assert.equal(attempt.expiresAt.getTime(), previousExpiry);
  assert.equal(findSetCookie(response, REGISTRATION_COOKIE_NAME), undefined);
});

test("resend optimistic miss cannot overwrite a concurrently consumed attempt", async (t) => {
  const token = generateRegistrationToken();
  const attempt = makeAttempt({ token, code: "123456" });
  const previousCodeHash = attempt.codeHash;
  const previousExpiry = attempt.expiresAt.getTime();
  const memory = createMemoryPrisma({
    attempts: [attempt],
    forceAttemptUpdateMiss: true,
  });
  const sender = new CapturingEmailSender();
  const app = await buildApp({ config, prisma: memory.client, emailSender: sender });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/resend",
    headers: { cookie: `${REGISTRATION_COOKIE_NAME}=${token}` },
    payload: { email: "user@example.com" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(sender.messages.length, 1);
  assert.equal(memory.stats.attemptUpdates, 1);
  assert.equal(attempt.codeHash, previousCodeHash);
  assert.equal(attempt.expiresAt.getTime(), previousExpiry);
  assert.equal(findSetCookie(response, REGISTRATION_COOKIE_NAME), undefined);
});

test("manual challenge limit returns 429 only after five allowed resends", async (t) => {
  const token = generateRegistrationToken();
  const memory = createMemoryPrisma({
    attempts: [makeAttempt({ token, code: "123456" })],
  });
  const sender = new CapturingEmailSender();
  const app = await buildApp({ config, prisma: memory.client, emailSender: sender });
  t.after(async () => app.close());

  for (let index = 0; index < 5; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/resend",
      headers: { cookie: `${REGISTRATION_COOKIE_NAME}=${token}` },
      payload: { email: "user@example.com" },
    });
    assert.equal(response.statusCode, 200);
  }
  const limited = await app.inject({
    method: "POST",
    url: "/api/v1/auth/resend",
    headers: {
      cookie: `${REGISTRATION_COOKIE_NAME}=${token}`,
      "x-request-id": "manual-rate-limit",
    },
    payload: { email: "user@example.com" },
  });

  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "RATE_LIMIT_VERIFY");
  assert.equal(limited.json().requestId, "manual-rate-limit");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(sender.messages.length, 5);
});

test("global login limit returns the shared 429 envelope before Prisma", async (t) => {
  const memory = createMemoryPrisma();
  const app = await buildApp({
    config,
    prisma: memory.client,
    emailSender: new CapturingEmailSender(),
  });
  t.after(async () => app.close());

  for (let index = 0; index < 40; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "wrong" },
    });
    assert.equal(response.statusCode, 401);
  }
  const limited = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "x-request-id": "global-rate-limit" },
    payload: { email: "user@example.com", password: "wrong" },
  });

  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "RATE_LIMIT_LOGIN");
  assert.equal(limited.json().requestId, "global-rate-limit");
  assert.ok(Number.isInteger(limited.json().error.details.retryAfterSeconds));
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(limited.headers["x-ratelimit-remaining"], "0");
  assert.equal(memory.stats.userFinds, 40);
});
