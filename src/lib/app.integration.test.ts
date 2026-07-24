import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";

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

function createFailingPrisma(): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get(_target, property) {
      throw new Error(
        `Unexpected Prisma access in route integration test: ${String(property)}`,
      );
    },
  });
}

test("API v1 route contracts", async (t) => {
  const app = await buildApp({ config, prisma: createFailingPrisma() });
  t.after(async () => app.close());

  await t.test("GET /api/v1/health returns service health", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json<{
      status: string;
      service: string;
      timestamp: string;
    }>();
    assert.equal(payload.status, "ok");
    assert.equal(payload.service, "duocards-backend");
    assert.equal(new Date(payload.timestamp).toISOString(), payload.timestamp);
  });

  await t.test("unknown v1 route returns the shared 404 envelope", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/does-not-exist",
      headers: { "x-request-id": "integration-404" },
    });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "Route not found",
        details: {
          method: "GET",
          path: "/api/v1/does-not-exist",
        },
      },
      requestId: "integration-404",
    });
  });

  await t.test(
    "protected flashcard-set list rejects requests without auth cookie",
    async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/flashcard-sets",
        headers: { "x-request-id": "integration-401" },
      });

      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), {
        error: {
          code: "UNAUTHORIZED",
          message: "Unauthorized",
        },
        requestId: "integration-401",
      });
    },
  );
});
