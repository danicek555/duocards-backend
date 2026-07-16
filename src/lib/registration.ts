import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { ApiError } from "./errors.js";

export const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1_000;
export const VERIFICATION_CODE_TTL_MINUTES = 10;
export const REGISTRATION_COOKIE_NAME = "registration";

const MAX_EMAIL_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 1_024;
const MAX_NICKNAME_LENGTH = 50;
const VERIFICATION_CODE_PATTERN = /^\d{6}$/;
const HASHED_VERIFICATION_CODE_PATTERN = /^[a-f0-9]{64}$/;
const SPECIAL_CHARACTER_PATTERN =
  /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/;

export const SUPPORTED_LOCALES = [
  "ar",
  "ca",
  "zh",
  "cs",
  "da",
  "nl",
  "en",
  "fi",
  "fr",
  "de",
  "el",
  "he",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "no",
  "pl",
  "pt",
  "ro",
  "ru",
  "es",
  "sv",
  "th",
  "tr",
  "uk",
  "vi",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export interface RegisterBody {
  email: string;
  password: string;
  nickname: string;
  locale: string;
}

export interface VerifyBody {
  email: string;
  code: string;
}

export interface ResendBody {
  email: string;
}

export interface NormalizedRegistration {
  email: string;
  password: string;
  nickname: string;
  locale: SupportedLocale;
}

export interface PasswordPolicyResult {
  isValid: boolean;
  strength: "weak" | "medium" | "strong";
  message: string;
  requirements: {
    minLength: boolean;
    hasUppercase: boolean;
    hasLowercase: boolean;
    hasNumbers: boolean;
    hasSpecialChars: boolean;
  };
}

export const registerBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password", "nickname", "locale"],
  properties: {
    email: { type: "string", maxLength: MAX_EMAIL_LENGTH },
    password: { type: "string", minLength: 1, maxLength: MAX_PASSWORD_LENGTH },
    nickname: { type: "string", maxLength: 200 },
    locale: { type: "string", maxLength: 35 },
  },
} as const;

export const verifyBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "code"],
  properties: {
    email: { type: "string", maxLength: MAX_EMAIL_LENGTH },
    code: { type: "string", pattern: "^[0-9]{6}$" },
  },
} as const;

export const resendBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: {
    email: { type: "string", maxLength: MAX_EMAIL_LENGTH },
  },
} as const;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isValidEmail(value: string): boolean {
  const emailPattern =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  if (!emailPattern.test(value)) return false;

  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const localPart = parts[0]!;
  const domain = parts[1]!;
  if (localPart.length < 1 || localPart.length > 64) return false;
  if (domain.length < 1 || domain.length > 253) return false;

  const domainParts = domain.split(".");
  if (domainParts.length < 2) return false;
  for (const part of domainParts) {
    if (
      part.length < 1 ||
      part.length > 63 ||
      !/^[a-zA-Z0-9-]+$/.test(part) ||
      part.startsWith("-") ||
      part.endsWith("-")
    ) {
      return false;
    }
  }
  const topLevelDomain = domainParts.at(-1)!;
  return topLevelDomain.length >= 2 && /^[a-zA-Z]+$/.test(topLevelDomain);
}

export function normalizeRegistrationEmail(rawEmail: string): string {
  const email = rawEmail.normalize("NFKC").trim().toLowerCase();
  if (!email || !isValidEmail(email)) {
    throw new ApiError(400, "INVALID_EMAIL", "Invalid email format");
  }
  return email;
}

function normalizeNickname(rawNickname: string): string {
  const nickname = rawNickname
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ");
  if (!nickname) {
    throw new ApiError(400, "INVALID_NICKNAME", "Nickname is required");
  }
  if (codePointLength(nickname) > MAX_NICKNAME_LENGTH) {
    throw new ApiError(
      400,
      "INVALID_NICKNAME",
      `Nickname must contain at most ${MAX_NICKNAME_LENGTH} characters`,
      { maximumLength: MAX_NICKNAME_LENGTH },
    );
  }
  return nickname;
}

function normalizeLocale(rawLocale: string): SupportedLocale {
  const locale = rawLocale.trim().toLowerCase().split(/[-_]/u)[0] ?? "";
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    throw new ApiError(400, "INVALID_LOCALE", "Unsupported locale");
  }
  return locale as SupportedLocale;
}

export function validatePasswordPolicy(
  password: string,
): PasswordPolicyResult {
  const requirements = {
    minLength: password.length >= 8,
    hasUppercase: /[A-Z]/.test(password),
    hasLowercase: /[a-z]/.test(password),
    hasNumbers: /\d/.test(password),
    hasSpecialChars: SPECIAL_CHARACTER_PATTERN.test(password),
  };
  const validCount = Object.values(requirements).filter(Boolean).length;
  const strength =
    validCount < 3 ? "weak" : validCount < 5 ? "medium" : "strong";
  return {
    isValid: validCount === 5,
    strength,
    message:
      strength === "weak"
        ? "Password is too weak"
        : strength === "medium"
          ? "Password is moderately strong"
          : "Password is strong",
    requirements,
  };
}

export function assertPasswordPolicy(password: string): void {
  const validation = validatePasswordPolicy(password);
  if (validation.isValid) return;
  throw new ApiError(
    400,
    validation.strength === "weak" ? "PASSWORD_WEAK" : "PASSWORD_MEDIUM",
    validation.message,
    { requirements: validation.requirements },
  );
}

export function normalizeRegistrationInput(
  input: RegisterBody,
): NormalizedRegistration {
  assertPasswordPolicy(input.password);
  return {
    email: normalizeRegistrationEmail(input.email),
    password: input.password,
    nickname: normalizeNickname(input.nickname),
    locale: normalizeLocale(input.locale),
  };
}

export function normalizeVerificationInput(input: VerifyBody): VerifyBody {
  const code = input.code.trim();
  if (!VERIFICATION_CODE_PATTERN.test(code)) {
    throw new ApiError(
      400,
      "INVALID_VERIFICATION_CODE_FORMAT",
      "Verification code must contain exactly 6 digits",
    );
  }
  return { email: normalizeRegistrationEmail(input.email), code };
}

export function normalizeResendInput(input: ResendBody): ResendBody {
  return { email: normalizeRegistrationEmail(input.email) };
}

export function generateVerificationCode(): string {
  return randomInt(100_000, 1_000_000).toString();
}

export function generateRegistrationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function verificationCodeExpiresAt(
  now: Date = new Date(),
): Date {
  return new Date(now.getTime() + VERIFICATION_CODE_TTL_MS);
}

export function hashVerificationCode(
  email: string,
  code: string,
  authSecret: string,
): string {
  return createHmac("sha256", authSecret)
    .update("duocards-email-verification:v1\0", "utf8")
    .update(email, "utf8")
    .update("\0", "utf8")
    .update(code, "utf8")
    .digest("hex");
}

export function hashRegistrationToken(
  registrationToken: string,
  authSecret: string,
): string {
  return createHmac("sha256", authSecret)
    .update("duocards-email-registration-token:v1\0", "utf8")
    .update(registrationToken, "utf8")
    .digest("hex");
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verificationCodeMatches(
  storedHash: string,
  submittedCode: string,
  email: string,
  authSecret: string,
): boolean {
  if (
    !VERIFICATION_CODE_PATTERN.test(submittedCode) ||
    !HASHED_VERIFICATION_CODE_PATTERN.test(storedHash)
  ) {
    return false;
  }
  return safeStringEqual(
    storedHash,
    hashVerificationCode(email, submittedCode, authSecret),
  );
}

export function isVerificationCodeExpired(
  expiresAt: Date,
  now: Date = new Date(),
): boolean {
  return expiresAt.getTime() <= now.getTime();
}
