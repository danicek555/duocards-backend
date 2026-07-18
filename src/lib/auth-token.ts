import { createHmac, timingSafeEqual } from "node:crypto";

export interface AuthPayload {
  userId: number;
  email: string;
  credentialVersion: string;
  exp: number;
}

export const AUTH_COOKIE_NAME = "auth";
export const AUTH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_AUTH_TOKEN_TTL_SECONDS = 60 * 60 * 24;
export const REMEMBERED_AUTH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const CREDENTIAL_VERSION_DOMAIN =
  "duocards-auth-credential-version:v1\0";

export function createCredentialVersion(
  passwordHash: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(CREDENTIAL_VERSION_DOMAIN, "utf8")
    .update(passwordHash, "utf8")
    .digest("base64url");
}

export function credentialVersionMatches(
  providedVersion: string,
  passwordHash: string,
  secret: string,
): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(providedVersion)) return false;
  const expected = Buffer.from(
    createCredentialVersion(passwordHash, secret),
    "base64url",
  );
  const provided = Buffer.from(providedVersion, "base64url");
  return (
    expected.length === provided.length &&
    timingSafeEqual(expected, provided)
  );
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(encodedPayload, "utf8")
    .digest("base64url");
}

export function createAuthToken(
  payload: Omit<AuthPayload, "credentialVersion" | "exp">,
  secret: string,
  passwordHash: string,
  ttlSeconds = AUTH_TOKEN_TTL_SECONDS,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const body: AuthPayload = {
    ...payload,
    credentialVersion: createCredentialVersion(passwordHash, secret),
    exp: nowSeconds + ttlSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(body), "utf8").toString(
    "base64url",
  );
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function verifyAuthToken(
  token: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): AuthPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const encodedPayload = parts[0];
  const providedSignature = parts[1];
  if (!encodedPayload || !providedSignature) return null;

  try {
    const expected = Buffer.from(sign(encodedPayload, secret), "base64url");
    const provided = Buffer.from(providedSignature, "base64url");
    if (expected.length !== provided.length) return null;
    if (!timingSafeEqual(expected, provided)) return null;

    const decoded = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<AuthPayload>;
    const userId = decoded.userId;
    const email = decoded.email;
    const credentialVersion = decoded.credentialVersion;
    const exp = decoded.exp;

    if (
      typeof userId !== "number" ||
      !Number.isInteger(userId) ||
      userId <= 0 ||
      typeof email !== "string" ||
      email.length === 0 ||
      typeof credentialVersion !== "string" ||
      credentialVersion.length === 0 ||
      typeof exp !== "number" ||
      !Number.isFinite(exp) ||
      exp <= nowSeconds
    ) {
      return null;
    }

    return { userId, email, credentialVersion, exp };
  } catch {
    return null;
  }
}
