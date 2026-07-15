import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./errors.js";
import {
  generateRegistrationToken,
  generateVerificationCode,
  hashRegistrationToken,
  hashVerificationCode,
  isVerificationCodeExpired,
  normalizeRegistrationInput,
  validatePasswordPolicy,
  verificationCodeExpiresAt,
  verificationCodeMatches,
  VERIFICATION_CODE_TTL_MS,
} from "./registration.js";

const authSecret = "test-secret-with-at-least-thirty-two-bytes";

test("registration normalization preserves the legacy password policy", () => {
  const normalized = normalizeRegistrationInput({
    email: "  USER@Example.COM ",
    password: "Strong1!",
    nickname: "  Ada    Lovelace  ",
    locale: "EN_us",
  });
  assert.deepEqual(normalized, {
    email: "user@example.com",
    password: "Strong1!",
    nickname: "Ada Lovelace",
    locale: "en",
  });

  assert.equal(validatePasswordPolicy("Strong1!").isValid, true);
  const missingSpecial = validatePasswordPolicy("Strong12");
  assert.equal(missingSpecial.isValid, false);
  assert.equal(missingSpecial.strength, "medium");
  assert.equal(missingSpecial.requirements.hasSpecialChars, false);

  assert.throws(
    () =>
      normalizeRegistrationInput({
        email: "user@example.com",
        password: "Strong12",
        nickname: "Ada",
        locale: "en",
      }),
    (error) =>
      error instanceof ApiError && error.code === "PASSWORD_MEDIUM",
  );
});

test("verification codes use six crypto-random digits and HMAC storage", () => {
  for (let index = 0; index < 100; index += 1) {
    assert.match(generateVerificationCode(), /^\d{6}$/);
  }

  const email = "user@example.com";
  const code = "123456";
  const storedHash = hashVerificationCode(email, code, authSecret);
  assert.match(storedHash, /^[a-f0-9]{64}$/);
  assert.notEqual(storedHash, code);
  assert.equal(
    verificationCodeMatches(storedHash, code, email, authSecret),
    true,
  );
  assert.equal(
    verificationCodeMatches(storedHash, "123457", email, authSecret),
    false,
  );
  assert.equal(verificationCodeMatches(code, code, email, authSecret), false);
  assert.equal(
    verificationCodeMatches(`v2.${storedHash}.${storedHash}`, code, email, authSecret),
    false,
    "the v1 registration API never accepts legacy or combined records",
  );
});

test("registration tokens contain 256 random bits and only their HMAC is stored", () => {
  const firstToken = generateRegistrationToken();
  const secondToken = generateRegistrationToken();
  assert.match(firstToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(firstToken, "base64url").byteLength, 32);
  assert.notEqual(firstToken, secondToken);

  const firstHash = hashRegistrationToken(firstToken, authSecret);
  assert.match(firstHash, /^[a-f0-9]{64}$/);
  assert.notEqual(firstHash, firstToken);
  assert.equal(firstHash, hashRegistrationToken(firstToken, authSecret));
  assert.notEqual(firstHash, hashRegistrationToken(secondToken, authSecret));
});

test("verification expiry uses the stored timestamp directly", () => {
  const now = new Date("2026-07-15T10:00:00.000Z");
  const expiresAt = verificationCodeExpiresAt(now);
  assert.equal(expiresAt.getTime() - now.getTime(), VERIFICATION_CODE_TTL_MS);
  assert.equal(isVerificationCodeExpired(expiresAt, now), false);
  assert.equal(isVerificationCodeExpired(expiresAt, expiresAt), true);
  assert.equal(
    isVerificationCodeExpired(
      expiresAt,
      new Date(expiresAt.getTime() - 1),
    ),
    false,
  );
});
