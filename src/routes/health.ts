import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

interface HealthRouteOptions {
  prisma: PrismaClient;
}

function healthPayload(status: "ok" | "unavailable") {
  return {
    status,
    service: "duocards-backend" as const,
    timestamp: new Date().toISOString(),
  };
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions,
): Promise<void> {
  // Liveness: the process is up. Kept dependency-free so a healthy container is
  // never restarted just because the database is briefly unreachable.
  app.get("/health", async () => healthPayload("ok"));
  app.get("/api/v1/health", async () => healthPayload("ok"));

  // Readiness: the process can actually serve requests, i.e. the database
  // answers. Point the platform's readiness/startup probe here.
  const readiness = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      await options.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      app.log.error(
        { err: error },
        "Readiness check failed: database unreachable",
      );
      reply.code(503);
      return healthPayload("unavailable");
    }
    return healthPayload("ok");
  };

  app.get("/ready", readiness);
  app.get("/api/v1/ready", readiness);
}
