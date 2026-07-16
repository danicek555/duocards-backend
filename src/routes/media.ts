import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { requireAuth } from "../lib/auth-guard.js";
import { ApiError } from "../lib/errors.js";
import { parsePositiveIntId } from "../lib/ids.js";

interface MediaRouteOptions {
  config: AppConfig;
  prisma: PrismaClient;
}

interface IdParams {
  id: string;
}

const idParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", pattern: "^[1-9][0-9]*$", maxLength: 10 },
  },
} as const;

export async function registerMediaRoutes(
  app: FastifyInstance,
  options: MediaRouteOptions,
): Promise<void> {
  const { config, prisma } = options;

  app.get<{ Params: IdParams }>(
    "/api/v1/word-images/:id",
    { schema: { params: idParamsSchema } },
    async (request) => {
      const auth = await requireAuth(request, config, prisma);
      const imageId = parsePositiveIntId(request.params.id, "image");

      const image = await prisma.wordImage.findUnique({
        where: { id: imageId },
        select: { id: true, dataUrl: true, mimeType: true },
      });
      if (!image) {
        throw new ApiError(404, "IMAGE_NOT_FOUND", "Image not found");
      }

      const ownedWord = await prisma.word.findFirst({
        where: { imageId, userId: auth.userId },
        select: { id: true },
      });
      if (!ownedWord) {
        throw new ApiError(403, "FORBIDDEN", "Forbidden");
      }
      return { image };
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/word-audio/:id",
    { schema: { params: idParamsSchema } },
    async (request) => {
      const auth = await requireAuth(request, config, prisma);
      const audioId = parsePositiveIntId(request.params.id, "audio");

      const audio = await prisma.wordAudio.findUnique({
        where: { id: audioId },
        select: { id: true, dataUrl: true, mimeType: true },
      });
      if (!audio) {
        throw new ApiError(404, "AUDIO_NOT_FOUND", "Audio not found");
      }

      const ownedWord = await prisma.word.findFirst({
        where: { audioId, userId: auth.userId },
        select: { id: true },
      });
      if (!ownedWord) {
        throw new ApiError(403, "FORBIDDEN", "Forbidden");
      }
      return { audio };
    },
  );
}
