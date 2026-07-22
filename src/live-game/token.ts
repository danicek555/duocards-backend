import { createHmac, timingSafeEqual } from "node:crypto";
import type { LiveGameTokenRole } from "./contracts.js";

const TOKEN_DOMAIN = "duocards-live-session:v1\0";
export const LIVE_GAME_TOKEN_TTL_SECONDS = 60 * 60 * 6;

export interface LiveGameTokenPayload {
  version: 1;
  sessionId: string;
  role: LiveGameTokenRole;
  participantId: string | null;
  exp: number;
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(TOKEN_DOMAIN, "utf8")
    .update(encodedPayload, "utf8")
    .digest("base64url");
}

export function createLiveGameToken(
  payload: Omit<LiveGameTokenPayload, "version" | "exp">,
  secret: string,
  ttlSeconds = LIVE_GAME_TOKEN_TTL_SECONDS,
  nowSeconds = Math.floor(Date.now() / 1_000),
): string {
  const body: LiveGameTokenPayload = {
    version: 1,
    ...payload,
    exp: nowSeconds + ttlSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(body), "utf8").toString(
    "base64url",
  );
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function verifyLiveGameToken(
  token: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): LiveGameTokenPayload | null {
  if (!token) return null;
  const [encodedPayload, providedSignature, extra] = token.split(".");
  if (!encodedPayload || !providedSignature || extra !== undefined) return null;

  try {
    const expected = Buffer.from(sign(encodedPayload, secret), "base64url");
    const provided = Buffer.from(providedSignature, "base64url");
    if (
      expected.length !== provided.length ||
      !timingSafeEqual(expected, provided)
    ) {
      return null;
    }

    const decoded = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<LiveGameTokenPayload>;
    if (
      decoded.version !== 1 ||
      typeof decoded.sessionId !== "string" ||
      decoded.sessionId.length === 0 ||
      (decoded.role !== "HOST" && decoded.role !== "PLAYER") ||
      (decoded.participantId !== null &&
        typeof decoded.participantId !== "string") ||
      typeof decoded.exp !== "number" ||
      !Number.isFinite(decoded.exp) ||
      decoded.exp <= nowSeconds ||
      (decoded.role === "HOST" && decoded.participantId !== null) ||
      (decoded.role === "PLAYER" && !decoded.participantId)
    ) {
      return null;
    }

    return decoded as LiveGameTokenPayload;
  } catch {
    return null;
  }
}

export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization);
  return match?.[1] ?? null;
}
