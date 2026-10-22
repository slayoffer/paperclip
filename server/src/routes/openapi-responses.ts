import { z } from "zod";

export function commonOpenApiResponses(ErrorSchema: unknown) {
  return {
    ok: (schema: z.ZodTypeAny = z.record(z.string(), z.unknown())) => ({
      description: "Success",
      content: { "application/json": { schema } },
    }),
    noContent: { description: "No content" },
    badRequest: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    unauthorized: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    forbidden: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorSchema } },
    },
    notFound: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    conflict: {
      description: "Conflict",
      content: { "application/json": { schema: ErrorSchema } },
    },
    payloadTooLarge: {
      description: "Payload too large",
      content: { "application/json": { schema: ErrorSchema } },
    },
    unsupportedMediaType: {
      description: "Unsupported media type",
      content: { "application/json": { schema: ErrorSchema } },
    },
    unprocessable: {
      description: "Unprocessable entity",
      content: { "application/json": { schema: ErrorSchema } },
    },
    serverError: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
    tooManyRequests: {
      description: "Too many requests",
      content: { "application/json": { schema: ErrorSchema } },
    },
  };
}
