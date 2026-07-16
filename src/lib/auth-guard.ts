import type { PrismaClient } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { ApiError } from "./errors.js";
import {
  AUTH_COOKIE_NAME,
  AUTH_TOKEN_TTL_SECONDS,
  type AuthPayload,
  credentialVersionMatches,
  verifyAuthToken,
} from "./auth-token.js";

export async function requireAuth(
  request: FastifyRequest,
  config: AppConfig,
  prisma: PrismaClient,
): Promise<AuthPayload> {
  const payload = verifyAuthToken(
    request.cookies[AUTH_COOKIE_NAME],
    config.authSecret,
  );
  if (!payload) {
    throw new ApiError(401, "UNAUTHORIZED", "Unauthorized");
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, password: true },
  });
  if (
    !user ||
    user.email !== payload.email ||
    !credentialVersionMatches(
      payload.credentialVersion,
      user.password,
      config.authSecret,
    )
  ) {
    throw new ApiError(401, "UNAUTHORIZED", "Unauthorized");
  }
  return payload;
}

export function authCookieOptions(config: AppConfig) {
  return {
    path: "/",
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax" as const,
    maxAge: AUTH_TOKEN_TTL_SECONDS,
  };
}

export function clearAuthCookieOptions(config: AppConfig) {
  return {
    path: "/",
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax" as const,
  };
}
