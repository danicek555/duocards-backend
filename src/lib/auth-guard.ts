import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { ApiError } from "./errors.js";
import {
  AUTH_COOKIE_NAME,
  AUTH_TOKEN_TTL_SECONDS,
  type AuthPayload,
  verifyAuthToken,
} from "./auth-token.js";

export function requireAuth(
  request: FastifyRequest,
  config: AppConfig,
): AuthPayload {
  const payload = verifyAuthToken(
    request.cookies[AUTH_COOKIE_NAME],
    config.authSecret,
  );
  if (!payload) {
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
