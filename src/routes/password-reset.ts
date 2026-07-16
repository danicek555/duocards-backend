import type { PrismaClient } from "@prisma/client";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { AppConfig } from "../config.js";
import { clearAuthCookieOptions } from "../lib/auth-guard.js";
import { AUTH_COOKIE_NAME } from "../lib/auth-token.js";
import { ApiError } from "../lib/errors.js";
import { hashPassword } from "../lib/password.js";
import {
  FORGOT_PASSWORD_SUCCESS_MESSAGE,
  forgotPasswordBodySchema,
  type ForgotPasswordBody,
  generatePasswordResetToken,
  hashPasswordResetEmailIdentity,
  hashPasswordResetToken,
  invalidOrExpiredResetToken,
  isPasswordResetTokenExpired,
  normalizeForgotPasswordInput,
  normalizeResetPasswordInput,
  PASSWORD_RESET_TOKEN_TTL_MINUTES,
  passwordResetTokenExpiresAt,
  passwordResetTokenLookupHashes,
  RESET_PASSWORD_SUCCESS_MESSAGE,
  resetPasswordBodySchema,
  type ResetPasswordBody,
} from "../lib/password-reset.js";
import type { PasswordResetEmailSender } from "../lib/password-reset-email.js";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;

interface PasswordResetRouteOptions {
  config: AppConfig;
  prisma: PrismaClient;
  emailSender: PasswordResetEmailSender;
}

type ManualRateLimiter = ReturnType<FastifyInstance["createRateLimit"]>;

interface ManualLimitResult {
  exceeded: boolean;
  retryAfterSeconds: number;
}

function createKeyRateLimiter(
  app: FastifyInstance,
  prefix: string,
  max: number,
  timeWindow: number,
) {
  const normalizedKeys = new WeakMap<FastifyRequest, string>();
  const limiter = app.createRateLimit({
    max,
    timeWindow,
    keyGenerator: (request) =>
      `${prefix}:${normalizedKeys.get(request) ?? request.ip}`,
  });

  return async (
    request: FastifyRequest,
    normalizedKey: string,
  ): Promise<ManualLimitResult> => {
    normalizedKeys.set(request, normalizedKey);
    let result: Awaited<ReturnType<ManualRateLimiter>>;
    try {
      result = await limiter(request);
    } finally {
      normalizedKeys.delete(request);
    }
    if (result.isAllowed) {
      return { exceeded: false, retryAfterSeconds: 0 };
    }
    return {
      exceeded: result.isExceeded,
      retryAfterSeconds: result.ttlInSeconds,
    };
  };
}

function sendForgotPasswordSuccess(
  reply: FastifyReply,
  retryAfterSeconds?: number,
) {
  if (retryAfterSeconds !== undefined) {
    reply.header("Retry-After", String(retryAfterSeconds));
  }
  return reply.status(200).send({
    message: FORGOT_PASSWORD_SUCCESS_MESSAGE,
  });
}

function logPasswordResetFailure(
  request: FastifyRequest,
  error: unknown,
  message: string,
): void {
  request.log.error(
    {
      passwordResetError:
        error instanceof Error ? error.name : "UnknownPasswordResetError",
    },
    message,
  );
}

function isPrismaNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2025"
  );
}

export async function registerPasswordResetRoutes(
  app: FastifyInstance,
  options: PasswordResetRouteOptions,
): Promise<void> {
  const { config, prisma, emailSender } = options;
  const limitForgotIp = createKeyRateLimiter(
    app,
    "forgot-password-ip",
    20,
    FIFTEEN_MINUTES_MS,
  );
  const limitForgotIpEmail = createKeyRateLimiter(
    app,
    "forgot-password-ip-email",
    5,
    FIFTEEN_MINUTES_MS,
  );
  const limitResetToken = createKeyRateLimiter(
    app,
    "reset-password-token",
    5,
    FIFTEEN_MINUTES_MS,
  );

  app.post<{ Body: ForgotPasswordBody }>(
    "/api/v1/auth/forgot-password",
    { schema: { body: forgotPasswordBodySchema } },
    async (request, reply) => {
      const input = normalizeForgotPasswordInput(request.body);
      const ipLimit = await limitForgotIp(request, request.ip);
      if (ipLimit.exceeded) {
        return sendForgotPasswordSuccess(
          reply,
          ipLimit.retryAfterSeconds,
        );
      }

      const emailIdentity = hashPasswordResetEmailIdentity(
        input.email,
        config.authSecret,
      );
      const emailLimit = await limitForgotIpEmail(
        request,
        `${request.ip}:${emailIdentity}`,
      );
      if (emailLimit.exceeded) {
        return sendForgotPasswordSuccess(
          reply,
          emailLimit.retryAfterSeconds,
        );
      }

      try {
        const user = await prisma.user.findUnique({
          where: { email: input.email },
          select: { id: true, email: true },
        });
        if (!user) return sendForgotPasswordSuccess(reply);

        const rawToken = generatePasswordResetToken();
        const tokenHash = hashPasswordResetToken(
          rawToken,
          config.authSecret,
        );
        const resetToken = await prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash,
            expiresAt: passwordResetTokenExpiresAt(),
          },
          select: { id: true },
        });

        try {
          await emailSender.sendPasswordReset({
            to: user.email,
            token: rawToken,
            expiresInMinutes: PASSWORD_RESET_TOKEN_TTL_MINUTES,
          });
        } catch (error) {
          try {
            await prisma.passwordResetToken.deleteMany({
              where: { id: resetToken.id, tokenHash },
            });
          } catch (cleanupError) {
            // The token remains high-entropy and expires after 30 minutes.
            logPasswordResetFailure(
              request,
              cleanupError,
              "Password reset token cleanup failed",
            );
          }
          logPasswordResetFailure(
            request,
            error,
            "Password reset email delivery failed",
          );
        }
      } catch (error) {
        // Every operational outcome uses the same public response. A durable
        // outbox is still required before public rollout to remove provider-I/O
        // timing differences between existing and unknown accounts.
        logPasswordResetFailure(
          request,
          error,
          "Forgot password request failed",
        );
      }

      return sendForgotPasswordSuccess(reply);
    },
  );

  app.post<{ Body: ResetPasswordBody }>(
    "/api/v1/auth/reset-password",
    {
      schema: { body: resetPasswordBodySchema },
      config: {
        rateLimit: {
          max: 20,
          timeWindow: FIFTEEN_MINUTES_MS,
          groupId: "reset-password-ip",
        },
      },
    },
    async (request, reply) => {
      const input = normalizeResetPasswordInput(request.body);
      const rateLimitTokenHash = hashPasswordResetToken(
        input.token,
        config.authSecret,
      );
      const tokenLimit = await limitResetToken(
        request,
        rateLimitTokenHash,
      );
      if (tokenLimit.exceeded) {
        reply.header(
          "Retry-After",
          String(tokenLimit.retryAfterSeconds),
        );
        throw new ApiError(
          429,
          "RATE_LIMIT_RESET_PASSWORD",
          "Too many password reset attempts. Please try again later.",
          { retryAfterSeconds: tokenLimit.retryAfterSeconds },
        );
      }

      const lookupHashes = passwordResetTokenLookupHashes(
        input.token,
        config.authSecret,
      );
      const resetToken = await prisma.passwordResetToken.findFirst({
        where: { tokenHash: { in: lookupHashes } },
        select: {
          id: true,
          userId: true,
          tokenHash: true,
          expiresAt: true,
        },
      });
      if (!resetToken) throw invalidOrExpiredResetToken();

      const lookupTime = new Date();
      if (isPasswordResetTokenExpired(resetToken.expiresAt, lookupTime)) {
        try {
          await prisma.passwordResetToken.deleteMany({
            where: {
              id: resetToken.id,
              tokenHash: resetToken.tokenHash,
              expiresAt: { lte: lookupTime },
            },
          });
        } catch (error) {
          logPasswordResetFailure(
            request,
            error,
            "Expired password reset token cleanup failed",
          );
        }
        throw invalidOrExpiredResetToken();
      }

      const passwordHash = await hashPassword(input.password);
      let resetSucceeded: boolean;
      try {
        resetSucceeded = await prisma.$transaction<boolean>(
          async (transaction) => {
            // Serialize every reset for one user before touching individual
            // token rows. Without this stable lock order, two valid tokens can
            // each lock themselves and deadlock while invalidating the other.
            const lockedUsers = await transaction.$queryRaw<
              Array<{ id: number }>
            >`
              SELECT "id"
              FROM "users"
              WHERE "id" = ${resetToken.userId}
              FOR UPDATE
            `;
            if (lockedUsers.length !== 1) return false;

            // Use the database wall clock after acquiring the user lock, so a
            // request that waited behind another reset cannot consume a token
            // which expired while it was queued.
            const consumed = await transaction.$executeRaw`
              DELETE FROM "password_reset_tokens"
              WHERE "id" = ${resetToken.id}
                AND "userId" = ${resetToken.userId}
                AND "tokenHash" = ${resetToken.tokenHash}
                AND "expiresAt" > clock_timestamp()
            `;
            if (consumed !== 1) return false;

            await transaction.user.update({
              where: { id: resetToken.userId },
              data: { password: passwordHash },
            });
            await transaction.passwordResetToken.deleteMany({
              where: { userId: resetToken.userId },
            });
            return true;
          },
        );
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          throw invalidOrExpiredResetToken();
        }
        throw error;
      }

      if (!resetSucceeded) throw invalidOrExpiredResetToken();

      reply.clearCookie(
        AUTH_COOKIE_NAME,
        clearAuthCookieOptions(config),
      );
      return reply.status(200).send({
        message: RESET_PASSWORD_SUCCESS_MESSAGE,
      });
    },
  );
}
