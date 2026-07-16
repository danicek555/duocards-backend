import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import {
  authCookieOptions,
  clearAuthCookieOptions,
  requireAuth,
} from "../lib/auth-guard.js";
import {
  AUTH_COOKIE_NAME,
  createAuthToken,
} from "../lib/auth-token.js";
import { ApiError } from "../lib/errors.js";
import { verifyPassword } from "../lib/password.js";

interface AuthRouteOptions {
  config: AppConfig;
  prisma: PrismaClient;
}

interface LoginBody {
  email: string;
  password: string;
}

const loginBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
    password: { type: "string", minLength: 1, maxLength: 1024 },
  },
} as const;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
): Promise<void> {
  const { config, prisma } = options;

  app.post<{ Body: LoginBody }>(
    "/api/v1/auth/login",
    {
      schema: { body: loginBodySchema },
      config: {
        rateLimit: {
          max: 40,
          timeWindow: 15 * 60 * 1000,
        },
      },
    },
    async (request, reply) => {
      const email = request.body.email.trim().toLowerCase();
      const password = request.body.password;
      if (!email || !password) {
        throw new ApiError(
          400,
          "REQUIRED_EMAIL_PASSWORD",
          "Email and password are required",
        );
      }
      if (!emailPattern.test(email)) {
        throw new ApiError(400, "INVALID_EMAIL", "Invalid email format");
      }

      const user = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          password: true,
          nickname: true,
          locale: true,
          createdAt: true,
        },
      });

      if (!user || !(await verifyPassword(password, user.password))) {
        throw new ApiError(
          401,
          "INVALID_CREDENTIALS",
          "Invalid email or password",
        );
      }

      const token = createAuthToken(
        { userId: user.id, email: user.email },
        config.authSecret,
        user.password,
      );
      reply.setCookie(
        AUTH_COOKIE_NAME,
        token,
        authCookieOptions(config),
      );

      return reply.status(200).send({
        message: "Login successful",
        user: {
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          locale: user.locale,
          createdAt: user.createdAt,
        },
      });
    },
  );

  app.get("/api/v1/auth/me", async (request) => {
    const auth = await requireAuth(request, config, prisma);
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: {
        id: true,
        email: true,
        nickname: true,
        locale: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new ApiError(404, "USER_NOT_FOUND", "User not found");
    }
    return { user };
  });

  app.post("/api/v1/auth/logout", async (_request, reply) => {
    reply.clearCookie(AUTH_COOKIE_NAME, clearAuthCookieOptions(config));
    return { message: "Logout successful" };
  });
}
