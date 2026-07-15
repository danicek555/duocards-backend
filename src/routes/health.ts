import type { FastifyInstance } from "fastify";

function healthPayload() {
  return {
    status: "ok" as const,
    service: "duocards-backend",
    timestamp: new Date().toISOString(),
  };
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => healthPayload());
  app.get("/api/v1/health", async () => healthPayload());
}
