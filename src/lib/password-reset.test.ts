import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ApiError } from "./errors.js";
import {
  generatePasswordResetToken,
  hashPasswordResetEmailIdentity,
  hashPasswordResetToken,
  isPasswordResetTokenExpired,
  normalizeForgotPasswordInput,
  normalizeResetPasswordInput,
  PASSWORD_RESET_TOKEN_TTL_MS,
  passwordResetTokenExpiresAt,
  passwordResetTokenLookupHashes,
} from "./password-reset.js";

const authSecret = "test-secret-with-at-least-thirty-two-bytes";

test("password reset input normalizes email and enforces password policy", () => {
  assert.deepEqual(
    normalizeForgotPasswordInput({ email: " USER@Example.COM " }),
    { email: "user@example.com" },
  );
  const token = generatePasswordResetToken();
  assert.deepEqual(
    normalizeResetPasswordInput({ token: ` ${token} `, password: "Strong1!" }),
    { token, password: "Strong1!" },
  );
  assert.throws(
    () =>
      normalizeResetPasswordInput({
        token,
        password: "Strong12",
      }),
    (error) =>
      error instanceof ApiError && error.code === "PASSWORD_MEDIUM",
  );
  assert.throws(
    () =>
      normalizeResetPasswordInput({
        token: "not-a-reset-token",
        password: "Strong1!",
      }),
    (error) =>
      error instanceof ApiError &&
      error.code === "INVALID_OR_EXPIRED_RESET_TOKEN",
  );
});

test("new reset tokens contain 256 bits and use domain-separated HMAC", () => {
  const first = generatePasswordResetToken();
  const second = generatePasswordResetToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(Buffer.from(first, "base64url").byteLength, 32);
  assert.notEqual(first, second);

  const firstHash = hashPasswordResetToken(first, authSecret);
  assert.match(firstHash, /^[a-f0-9]{64}$/u);
  assert.notEqual(firstHash, first);
  assert.equal(firstHash, hashPasswordResetToken(first, authSecret));
  assert.notEqual(firstHash, hashPasswordResetToken(second, authSecret));

  const emailHash = hashPasswordResetEmailIdentity(
    "user@example.com",
    authSecret,
  );
  assert.match(emailHash, /^[a-f0-9]{64}$/u);
  assert.notEqual(emailHash, "user@example.com");
});

test("lookup supports only current HMAC and cutover legacy SHA-256", () => {
  const currentToken = generatePasswordResetToken();
  assert.deepEqual(passwordResetTokenLookupHashes(currentToken, authSecret), [
    hashPasswordResetToken(currentToken, authSecret),
  ]);

  const legacyToken = "a".repeat(64);
  assert.deepEqual(passwordResetTokenLookupHashes(legacyToken, authSecret), [
    hashPasswordResetToken(legacyToken, authSecret),
    createHash("sha256").update(legacyToken).digest("hex"),
  ]);
});

test("password reset expiry uses the exact stored timestamp", () => {
  const now = new Date("2026-07-16T10:00:00.000Z");
  const expiresAt = passwordResetTokenExpiresAt(now);
  assert.equal(expiresAt.getTime() - now.getTime(), PASSWORD_RESET_TOKEN_TTL_MS);
  assert.equal(isPasswordResetTokenExpired(expiresAt, now), false);
  assert.equal(isPasswordResetTokenExpired(expiresAt, expiresAt), true);
});
