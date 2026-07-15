import assert from "node:assert/strict";
import test from "node:test";
import { createAuthToken, verifyAuthToken } from "./auth-token.js";

const secret = "test-secret-with-at-least-thirty-two-bytes";
const now = 1_800_000_000;

test("auth token round-trips with the legacy body.signature contract", () => {
  const token = createAuthToken(
    { userId: 42, email: "user@example.test" },
    secret,
    60,
    now,
  );

  assert.deepEqual(verifyAuthToken(token, secret, now), {
    userId: 42,
    email: "user@example.test",
    exp: now + 60,
  });
});

test("auth token rejects a modified signature", () => {
  const token = createAuthToken(
    { userId: 42, email: "user@example.test" },
    secret,
    60,
    now,
  );
  const [body] = token.split(".");
  assert.equal(verifyAuthToken(`${body}.invalid`, secret, now), null);
});

test("auth token rejects an expired payload", () => {
  const token = createAuthToken(
    { userId: 42, email: "user@example.test" },
    secret,
    1,
    now,
  );
  assert.equal(verifyAuthToken(token, secret, now + 1), null);
});
