import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function sendApiError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
) {
  const error: ApiErrorPayload["error"] = { code, message };
  if (details !== undefined) error.details = details;

  const payload: ApiErrorPayload = {
    error,
    requestId: reply.request.id,
  };
  return reply.status(statusCode).send(payload);
}

export function installErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    sendApiError(reply, 404, "ROUTE_NOT_FOUND", "Route not found", {
      method: request.method,
      path: request.url,
    }),
  );

  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (error instanceof ApiError) {
      return sendApiError(
        reply,
        error.statusCode,
        error.code,
        error.message,
        error.details,
      );
    }

    if (error.validation) {
      return sendApiError(
        reply,
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
        error.validation.map((issue) => ({
          instancePath: issue.instancePath,
          message: issue.message,
        })),
      );
    }

    request.log.error({ err: error }, "Unhandled request error");
    return sendApiError(
      reply,
      500,
      "INTERNAL_ERROR",
      "An unexpected server error occurred",
    );
  });
}
