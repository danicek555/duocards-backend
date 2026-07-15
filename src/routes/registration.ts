import type { PrismaClient } from "@prisma/client";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { AppConfig } from "../config.js";
import { authCookieOptions } from "../lib/auth-guard.js";
import { AUTH_COOKIE_NAME, createAuthToken } from "../lib/auth-token.js";
import { ApiError } from "../lib/errors.js";
import { hashPassword } from "../lib/password.js";
import {
  generateRegistrationToken,
  generateVerificationCode,
  hashRegistrationToken,
  hashVerificationCode,
  isVerificationCodeExpired,
  normalizeRegistrationInput,
  normalizeResendInput,
  normalizeVerificationInput,
  REGISTRATION_COOKIE_NAME,
  registerBodySchema,
  resendBodySchema,
  type RegisterBody,
  type ResendBody,
  VERIFICATION_CODE_TTL_MINUTES,
  verificationCodeExpiresAt,
  verificationCodeMatches,
  verifyBodySchema,
  type VerifyBody,
} from "../lib/registration.js";
import type { VerificationEmailSender } from "../lib/verification-email.js";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const TEN_MINUTES_MS = 10 * 60 * 1_000;
const RESEND_SUCCESS_MESSAGE =
  "If a pending registration exists, a verification code has been sent.";

interface RegistrationRouteOptions {
  config: AppConfig;
  prisma: PrismaClient;
  emailSender: VerificationEmailSender;
}

type ManualRateLimiter = ReturnType<FastifyInstance["createRateLimit"]>;

interface VerifiedUser {
  id: number;
  email: string;
  nickname: string;
  locale: string;
  emailVerified: boolean;
  createdAt: Date;
}

type VerificationResult =
  | { kind: "verified"; user: VerifiedUser }
  | { kind: "invalid-challenge" }
  | { kind: "invalid-code" }
  | { kind: "expired" };

function registrationCookieOptions(config: AppConfig, expiresAt: Date) {
  return {
    path: "/",
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax" as const,
    maxAge: Math.max(
      0,
      Math.floor((expiresAt.getTime() - Date.now()) / 1_000),
    ),
  };
}

function clearRegistrationCookieOptions(config: AppConfig) {
  return {
    path: "/",
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax" as const,
  };
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
    reply: FastifyReply,
    normalizedKey: string,
    errorCode: string,
  ): Promise<void> => {
    normalizedKeys.set(request, normalizedKey);
    let result: Awaited<ReturnType<ManualRateLimiter>>;
    try {
      result = await limiter(request);
    } finally {
      normalizedKeys.delete(request);
    }

    // The plugin reports ordinary, non-exceeded calls with both flags false.
    if (result.isAllowed || !result.isExceeded) return;

    reply.header("Retry-After", String(result.ttlInSeconds));
    throw new ApiError(
      429,
      errorCode,
      "Too many requests. Please try again later.",
      { retryAfterSeconds: result.ttlInSeconds },
    );
  };
}

function logRegistrationFailure(
  request: FastifyRequest,
  error: unknown,
  message: string,
): void {
  request.log.error(
    {
      registrationError:
        error instanceof Error ? error.name : "UnknownRegistrationError",
    },
    message,
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function invalidRegistrationChallenge(): ApiError {
  return new ApiError(
    400,
    "INVALID_REGISTRATION_CHALLENGE",
    "Invalid registration challenge",
  );
}

export async function registerRegistrationRoutes(
  app: FastifyInstance,
  options: RegistrationRouteOptions,
): Promise<void> {
  const { config, prisma, emailSender } = options;
  const limitRegisterEmail = createKeyRateLimiter(
    app,
    "register-email",
    5,
    FIFTEEN_MINUTES_MS,
  );
  const limitVerifyChallenge = createKeyRateLimiter(
    app,
    "verify-challenge",
    10,
    FIFTEEN_MINUTES_MS,
  );
  const limitResendChallenge = createKeyRateLimiter(
    app,
    "resend-challenge",
    5,
    TEN_MINUTES_MS,
  );
  const limitResendEmail = createKeyRateLimiter(
    app,
    "resend-email",
    5,
    TEN_MINUTES_MS,
  );

  app.post<{ Body: RegisterBody }>(
    "/api/v1/auth/register",
    {
      schema: { body: registerBodySchema },
      config: {
        rateLimit: {
          max: 20,
          timeWindow: FIFTEEN_MINUTES_MS,
          groupId: "registration-ip",
        },
      },
    },
    async (request, reply) => {
      const input = normalizeRegistrationInput(request.body);
      await limitRegisterEmail(
        request,
        reply,
        input.email,
        "RATE_LIMIT_REGISTER",
      );

      const existingUser = await prisma.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      if (existingUser) {
        throw new ApiError(
          409,
          "EMAIL_EXISTS",
          "User with this email already exists",
        );
      }

      const passwordHash = await hashPassword(input.password);
      const verificationCode = generateVerificationCode();
      const registrationToken = generateRegistrationToken();
      const tokenHash = hashRegistrationToken(
        registrationToken,
        config.authSecret,
      );
      const expiresAt = verificationCodeExpiresAt();
      const attempt = await prisma.registrationAttempt.create({
        data: {
          tokenHash,
          email: input.email,
          password: passwordHash,
          nickname: input.nickname,
          locale: input.locale,
          codeHash: hashVerificationCode(
            input.email,
            verificationCode,
            config.authSecret,
          ),
          expiresAt,
        },
        select: { id: true },
      });

      try {
        await emailSender.sendVerificationCode({
          to: input.email,
          code: verificationCode,
          expiresInMinutes: VERIFICATION_CODE_TTL_MINUTES,
        });
      } catch (error) {
        try {
          await prisma.registrationAttempt.deleteMany({
            where: { id: attempt.id, tokenHash },
          });
        } catch (cleanupError) {
          // The raw token was never issued, so an orphan is inert until expiry.
          logRegistrationFailure(
            request,
            cleanupError,
            "Registration attempt cleanup failed",
          );
        }
        reply.clearCookie(
          REGISTRATION_COOKIE_NAME,
          clearRegistrationCookieOptions(config),
        );
        logRegistrationFailure(
          request,
          error,
          "Verification email delivery failed",
        );
        throw new ApiError(
          503,
          "EMAIL_DELIVERY_UNAVAILABLE",
          "Verification email could not be delivered. Please try again.",
        );
      }

      reply.setCookie(
        REGISTRATION_COOKIE_NAME,
        registrationToken,
        registrationCookieOptions(config, expiresAt),
      );
      return reply.status(201).send({
        message:
          "Registration successful! Please check your email for a verification code.",
        email: input.email,
        requiresVerification: true,
      });
    },
  );

  app.post<{ Body: VerifyBody }>(
    "/api/v1/auth/verify",
    {
      schema: { body: verifyBodySchema },
      config: {
        rateLimit: {
          max: 30,
          timeWindow: FIFTEEN_MINUTES_MS,
          groupId: "verification-ip",
        },
      },
    },
    async (request, reply) => {
      const input = normalizeVerificationInput(request.body);
      const registrationToken =
        request.cookies[REGISTRATION_COOKIE_NAME];
      if (!registrationToken) throw invalidRegistrationChallenge();
      const tokenHash = hashRegistrationToken(
        registrationToken,
        config.authSecret,
      );
      await limitVerifyChallenge(
        request,
        reply,
        tokenHash,
        "RATE_LIMIT_VERIFY",
      );
      const now = new Date();

      let result: VerificationResult;
      try {
        result = await prisma.$transaction<VerificationResult>(
          async (transaction) => {
            const attempt =
              await transaction.registrationAttempt.findUnique({
                where: { tokenHash },
              });
            if (!attempt || attempt.email !== input.email) {
              return { kind: "invalid-challenge" };
            }

            if (isVerificationCodeExpired(attempt.expiresAt, now)) {
              await transaction.registrationAttempt.deleteMany({
                where: { id: attempt.id, tokenHash },
              });
              return { kind: "expired" };
            }

            if (
              !verificationCodeMatches(
                attempt.codeHash,
                input.code,
                attempt.email,
                config.authSecret,
              )
            ) {
              return { kind: "invalid-code" };
            }

            const user = await transaction.user.create({
              data: {
                email: attempt.email,
                password: attempt.password,
                nickname: attempt.nickname,
                locale: attempt.locale,
                emailVerified: true,
              },
              select: {
                id: true,
                email: true,
                nickname: true,
                locale: true,
                emailVerified: true,
                createdAt: true,
              },
            });
            await transaction.registrationAttempt.deleteMany({
              where: { email: attempt.email },
            });
            return { kind: "verified", user };
          },
        );
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          reply.clearCookie(
            REGISTRATION_COOKIE_NAME,
            clearRegistrationCookieOptions(config),
          );
          throw new ApiError(
            409,
            "EMAIL_EXISTS",
            "User with this email already exists",
          );
        }
        throw error;
      }

      if (result.kind === "invalid-challenge") {
        throw invalidRegistrationChallenge();
      }
      if (result.kind === "invalid-code") {
        throw new ApiError(
          400,
          "INVALID_VERIFICATION_CODE",
          "Invalid verification code",
        );
      }
      if (result.kind === "expired") {
        reply.clearCookie(
          REGISTRATION_COOKIE_NAME,
          clearRegistrationCookieOptions(config),
        );
        throw new ApiError(
          400,
          "VERIFICATION_CODE_EXPIRED",
          "Verification code has expired. Please register again.",
        );
      }

      const token = createAuthToken(
        { userId: result.user.id, email: result.user.email },
        config.authSecret,
      );
      reply.setCookie(AUTH_COOKIE_NAME, token, authCookieOptions(config));
      reply.clearCookie(
        REGISTRATION_COOKIE_NAME,
        clearRegistrationCookieOptions(config),
      );
      return reply.status(200).send({
        message: "Email verified successfully!",
        user: result.user,
      });
    },
  );

  app.post<{ Body: ResendBody }>(
    "/api/v1/auth/resend",
    {
      schema: { body: resendBodySchema },
      config: {
        rateLimit: {
          max: 20,
          timeWindow: FIFTEEN_MINUTES_MS,
          groupId: "resend-ip",
        },
      },
    },
    async (request, reply) => {
      const input = normalizeResendInput(request.body);
      const registrationToken =
        request.cookies[REGISTRATION_COOKIE_NAME];
      if (!registrationToken) {
        return reply.status(200).send({ message: RESEND_SUCCESS_MESSAGE });
      }
      const tokenHash = hashRegistrationToken(
        registrationToken,
        config.authSecret,
      );
      await limitResendChallenge(
        request,
        reply,
        tokenHash,
        "RATE_LIMIT_VERIFY",
      );

      try {
        const attempt = await prisma.registrationAttempt.findUnique({
          where: { tokenHash },
          select: {
            id: true,
            tokenHash: true,
            email: true,
            codeHash: true,
            expiresAt: true,
          },
        });
        if (!attempt || attempt.email !== input.email) {
          return reply.status(200).send({ message: RESEND_SUCCESS_MESSAGE });
        }

        if (isVerificationCodeExpired(attempt.expiresAt)) {
          await prisma.registrationAttempt.deleteMany({
            where: { id: attempt.id, tokenHash: attempt.tokenHash },
          });
          reply.clearCookie(
            REGISTRATION_COOKIE_NAME,
            clearRegistrationCookieOptions(config),
          );
          return reply.status(200).send({ message: RESEND_SUCCESS_MESSAGE });
        }

        await limitResendEmail(
          request,
          reply,
          input.email,
          "RATE_LIMIT_VERIFY",
        );

        const verificationCode = generateVerificationCode();
        const codeHash = hashVerificationCode(
          input.email,
          verificationCode,
          config.authSecret,
        );
        // Delivery happens first: provider failure cannot invalidate the old code.
        await emailSender.sendVerificationCode({
          to: input.email,
          code: verificationCode,
          expiresInMinutes: VERIFICATION_CODE_TTL_MINUTES,
        });
        const expiresAt = verificationCodeExpiresAt();
        const update = await prisma.registrationAttempt.updateMany({
          where: {
            id: attempt.id,
            tokenHash: attempt.tokenHash,
            email: attempt.email,
            codeHash: attempt.codeHash,
          },
          data: { codeHash, expiresAt },
        });

        // An optimistic predicate prevents an older concurrent resend from
        // overwriting a newer code. A durable mail outbox is still required
        // before horizontally scaled production rollout.
        if (update.count === 1) {
          reply.setCookie(
            REGISTRATION_COOKIE_NAME,
            registrationToken,
            registrationCookieOptions(config, expiresAt),
          );
        }
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 429) {
          throw error;
        }
        // Missing, stale, provider, and database outcomes share one response.
        logRegistrationFailure(
          request,
          error,
          "Verification email resend failed",
        );
      }

      return reply.status(200).send({ message: RESEND_SUCCESS_MESSAGE });
    },
  );
}
