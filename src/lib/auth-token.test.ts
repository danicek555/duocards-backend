import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createAuthToken,
  createCredentialVersion,
  credentialVersionMatches,
  verifyAuthToken,
} from "./auth-token.js";

const secret = "test-secret-with-at-least-thirty-two-bytes";
const passwordHash = "$argon2id$test-current-password-hash";
const now = 1_800_000_000;

test("auth token round-trips with a required credential version", () => {
  const token = createAuthToken(
    { userId: 42, email: "user@example.test" },
    secret,
    passwordHash,
    60,
    now,
  );

  assert.deepEqual(verifyAuthToken(token, secret, now), {
    userId: 42,
    email: "user@example.test",
    credentialVersion: createCredentialVersion(passwordHash, secret),
    exp: now + 60,
  });
});

test("credential version is password-hash bound and compared safely", () => {
  const version = createCredentialVersion(passwordHash, secret);

  assert.equal(
    version,
    "AW2MoKk7FnpIGL-0Ra4yXZi8ZHYRhk33Tqx1MFktq8I",
  );
  assert.equal(
    credentialVersionMatches(version, passwordHash, secret),
    true,
  );
  assert.equal(
    credentialVersionMatches(
      version,
      "$argon2id$a-new-salted-password-hash",
      secret,
    ),
    false,
  );
});

test("auth token rejects a modified signature", () => {
  const token = createAuthToken(
    { userId: 42, email: "user@example.test" },
    secret,
    passwordHash,
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
    passwordHash,
    1,
    now,
  );
  assert.equal(verifyAuthToken(token, secret, now + 1), null);
});

test("auth token rejects a signed legacy payload without credentialVersion", () => {
  const body = Buffer.from(
    JSON.stringify({
      userId: 42,
      email: "user@example.test",
      exp: now + 60,
    }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64url");

  assert.equal(verifyAuthToken(`${body}.${signature}`, secret, now), null);
});
