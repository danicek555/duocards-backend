import { createHash, createHmac, randomBytes } from "node:crypto";
import { ApiError } from "./errors.js";
import {
  assertPasswordPolicy,
  normalizeRegistrationEmail,
} from "./registration.js";

export const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1_000;
export const PASSWORD_RESET_TOKEN_TTL_MINUTES = 30;

const MAX_EMAIL_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 1_024;
const MAX_TOKEN_LENGTH = 256;
const NEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LEGACY_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

export const FORGOT_PASSWORD_SUCCESS_MESSAGE =
  "If an account with this email exists, we sent a password reset link. " +
  "Please check your spam or junk folder too.";
export const RESET_PASSWORD_SUCCESS_MESSAGE =
  "Password reset successful. You can now sign in.";

export interface ForgotPasswordBody {
  email: string;
}

export interface ResetPasswordBody {
  token: string;
  password: string;
}

export const forgotPasswordBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: {
    email: { type: "string", maxLength: MAX_EMAIL_LENGTH },
  },
} as const;

export const resetPasswordBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["token", "password"],
  properties: {
    token: { type: "string", minLength: 1, maxLength: MAX_TOKEN_LENGTH },
    password: { type: "string", minLength: 1, maxLength: MAX_PASSWORD_LENGTH },
  },
} as const;

export function normalizeForgotPasswordInput(
  input: ForgotPasswordBody,
): ForgotPasswordBody {
  return { email: normalizeRegistrationEmail(input.email) };
}

export function normalizeResetPasswordInput(
  input: ResetPasswordBody,
): ResetPasswordBody {
  assertPasswordPolicy(input.password);
  const token = input.token.trim();
  if (!isSupportedPasswordResetToken(token)) {
    throw invalidOrExpiredResetToken();
  }
  return { token, password: input.password };
}

export function generatePasswordResetToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashPasswordResetToken(
  token: string,
  authSecret: string,
): string {
  return createHmac("sha256", authSecret)
    .update("duocards-password-reset-token:v1\0", "utf8")
    .update(token, "utf8")
    .digest("hex");
}

export function passwordResetTokenLookupHashes(
  token: string,
  authSecret: string,
): string[] {
  const currentHash = hashPasswordResetToken(token, authSecret);
  if (!LEGACY_TOKEN_PATTERN.test(token)) return [currentHash];
  return [
    currentHash,
    createHash("sha256").update(token, "utf8").digest("hex"),
  ];
}

export function hashPasswordResetEmailIdentity(
  normalizedEmail: string,
  authSecret: string,
): string {
  return createHmac("sha256", authSecret)
    .update("duocards-password-reset-email-rate-limit:v1\0", "utf8")
    .update(normalizedEmail, "utf8")
    .digest("hex");
}

export function passwordResetTokenExpiresAt(
  now: Date = new Date(),
): Date {
  return new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);
}

export function isPasswordResetTokenExpired(
  expiresAt: Date,
  now: Date = new Date(),
): boolean {
  return expiresAt.getTime() <= now.getTime();
}

export function invalidOrExpiredResetToken(): ApiError {
  return new ApiError(
    400,
    "INVALID_OR_EXPIRED_RESET_TOKEN",
    "Invalid or expired reset token",
  );
}

function isSupportedPasswordResetToken(token: string): boolean {
  return NEW_TOKEN_PATTERN.test(token) || LEGACY_TOKEN_PATTERN.test(token);
}
