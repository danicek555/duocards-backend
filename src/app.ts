import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { PrismaClient } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { loadConfig, type AppConfig } from "./config.js";
import { ApiError, installErrorHandlers } from "./lib/errors.js";
import { createDatabase } from "./lib/prisma.js";
import {
  createPasswordResetEmailSender,
  type PasswordResetEmailSender,
} from "./lib/password-reset-email.js";
import {
  createVerificationEmailSender,
  type VerificationEmailSender,
} from "./lib/verification-email.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerFlashcardSetRoutes } from "./routes/flashcard-sets.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerLiveSessionRoutes } from "./routes/live-sessions.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerPasswordResetRoutes } from "./routes/password-reset.js";
import { registerRegistrationRoutes } from "./routes/registration.js";
import { registerUserRoutes } from "./routes/user.js";

export interface BuildAppOptions {
  config?: AppConfig;
  prisma?: PrismaClient;
  emailSender?: VerificationEmailSender;
  passwordResetEmailSender?: PasswordResetEmailSender;
}

const RATE_LIMIT_ERRORS = {
  "/api/v1/auth/login": {
    code: "RATE_LIMIT_LOGIN",
    message: "Too many login attempts. Please try again later.",
  },
  "/api/v1/auth/register": {
    code: "RATE_LIMIT_REGISTER",
    message: "Too many registration attempts. Please try again later.",
  },
  "/api/v1/auth/verify": {
    code: "RATE_LIMIT_VERIFY",
    message: "Too many verification attempts. Please try again later.",
  },
  "/api/v1/auth/resend": {
    code: "RATE_LIMIT_VERIFY",
    message: "Too many resend attempts. Please try again later.",
  },
  "/api/v1/auth/reset-password": {
    code: "RATE_LIMIT_RESET_PASSWORD",
    message: "Too many password reset attempts. Please try again later.",
  },
} as const;

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const database = options.prisma
    ? { prisma: options.prisma, close: async () => undefined }
    : createDatabase(config.databaseUrl);
  const emailSender =
    options.emailSender ?? createVerificationEmailSender(config);
  const passwordResetEmailSender =
    options.passwordResetEmailSender ??
    createPasswordResetEmailSender(config);

  const app = Fastify({
    logger:
      config.nodeEnv === "test" ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
    requestIdHeader: "x-request-id",
    ajv: {
      customOptions: {
        // Reject unknown contract fields instead of silently stripping them.
        removeAdditional: false,
      },
    },
  });

  installErrorHandlers(app);

  // Security headers. This is a JSON/data API with no document surface, so the
  // strictest content policy applies and framing is denied outright. HSTS is
  // only meaningful over HTTPS, so it is limited to production.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
    hsts:
      config.nodeEnv === "production"
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
  });

  // Authenticated API responses (and media data URLs) must never be cached by
  // shared caches or the browser.
  app.addHook("onSend", async (_request, reply, payload) => {
    if (!reply.hasHeader("Cache-Control")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  await app.register(cookie);

  // Rate limiting needs a store shared across instances; the default in-process
  // store resets on every cold start and is per-container, so on a horizontally
  // scaled platform (Cloud Run) it cannot enforce a real limit. Use Redis when
  // configured and warn loudly in production when it is missing.
  let rateLimitRedis: Redis | undefined;
  if (config.redisUrl) {
    rateLimitRedis = new Redis(config.redisUrl, {
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
    });
    rateLimitRedis.on("error", (error: Error) => {
      app.log.error({ err: error }, "Rate-limit Redis connection error");
    });
  } else if (config.nodeEnv === "production") {
    app.log.warn(
      "REDIS_URL is not set — rate limiting uses an in-process store that does not hold across multiple instances or restarts",
    );
  }

  await app.register(rateLimit, {
    global: false,
    redis: rateLimitRedis,
    errorResponseBuilder: (request, context) => {
      const routeError =
        RATE_LIMIT_ERRORS[
          request.routeOptions.url as keyof typeof RATE_LIMIT_ERRORS
        ] ?? {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests. Please try again later.",
        };
      return new ApiError(
        context.statusCode,
        routeError.code,
        routeError.message,
        { retryAfterSeconds: Math.ceil(context.ttl / 1_000) },
      );
    },
  });

  const allowedOrigins = new Set(config.corsOrigins);
  await app.register(cors, {
    credentials: true,
    origin: (origin, callback) => {
      // Requests from native clients and server-to-server callers have no Origin.
      if (!origin) return callback(null, true);
      const normalized = origin.replace(/\/$/, "");
      return callback(null, allowedOrigins.has(normalized));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Request-Id"],
  });

  await registerHealthRoutes(app, { prisma: database.prisma });
  await registerAuthRoutes(app, { config, prisma: database.prisma });
  await registerRegistrationRoutes(app, {
    config,
    prisma: database.prisma,
    emailSender,
  });
  await registerPasswordResetRoutes(app, {
    config,
    prisma: database.prisma,
    emailSender: passwordResetEmailSender,
  });
  await registerFlashcardSetRoutes(app, {
    config,
    prisma: database.prisma,
  });
  await registerUserRoutes(app, { config, prisma: database.prisma });
  await registerMediaRoutes(app, { config, prisma: database.prisma });
  await registerLiveSessionRoutes(app, {
    config,
    prisma: database.prisma,
  });

  app.addHook("onClose", async () => {
    if (rateLimitRedis) {
      await rateLimitRedis.quit().catch(() => undefined);
    }
    await database.close();
  });

  return app;
}
