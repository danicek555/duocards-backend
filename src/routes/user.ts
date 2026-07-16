import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { requireAuth } from "../lib/auth-guard.js";
import { ApiError } from "../lib/errors.js";

interface UserRouteOptions {
  config: AppConfig;
  prisma: PrismaClient;
}

export async function registerUserRoutes(
  app: FastifyInstance,
  options: UserRouteOptions,
): Promise<void> {
  const { config, prisma } = options;

  app.get("/api/v1/user/coins", async (request) => {
    const auth = await requireAuth(request, config, prisma);
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { coins: true },
    });

    if (!user) {
      throw new ApiError(404, "USER_NOT_FOUND", "User not found");
    }
    return { coins: user.coins };
  });
}
