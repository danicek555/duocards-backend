import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { PrismaClient } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig, type AppConfig } from "./config.js";
import { installErrorHandlers } from "./lib/errors.js";
import { createDatabase } from "./lib/prisma.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerFlashcardSetRoutes } from "./routes/flashcard-sets.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerUserRoutes } from "./routes/user.js";

export interface BuildAppOptions {
  config?: AppConfig;
  prisma?: PrismaClient;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const database = options.prisma
    ? { prisma: options.prisma, close: async () => undefined }
    : createDatabase(config.databaseUrl);

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

  await app.register(cookie);

  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (request) => ({
      error: {
        code: "RATE_LIMIT_LOGIN",
        message: "Too many login attempts. Please try again later.",
      },
      requestId: request.id,
    }),
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

  await registerHealthRoutes(app);
  await registerAuthRoutes(app, { config, prisma: database.prisma });
  await registerFlashcardSetRoutes(app, {
    config,
    prisma: database.prisma,
  });
  await registerUserRoutes(app, { config, prisma: database.prisma });
  await registerMediaRoutes(app, { config, prisma: database.prisma });

  app.addHook("onClose", async () => {
    await database.close();
  });

  return app;
}
