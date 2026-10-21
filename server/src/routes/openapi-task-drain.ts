import type { OpenApiPathRegistration, OpenApiResponse } from "./openapi-types.js";
import { z } from "zod";
import { startTaskDrainRequestSchema, stopTaskDrainRequestSchema } from "@paperclipai/shared";

type Response = OpenApiResponse;
type Responses = { ok: () => Response } & Record<"badRequest" | "unauthorized" | "forbidden" | "conflict", Response>;

export function registerTaskDrainPaths(registry: { registerPath(path: OpenApiPathRegistration): void }, r: Responses) {
  const jsonBody = (schema: z.ZodTypeAny) => ({
    content: { "application/json": { schema } }, required: true as const,
  });
  registry.registerPath({
    method: "get",
    path: "/api/instance/task-drain",
    tags: ["instance"],
    summary:
      "Read the persisted drain lease and local and database work counts. The lease survives server recreation.",
    description: "Quiescent requires zero local promises and zero persisted running, queued, scheduled-retry, and pending wake records.",
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  registry.registerPath({
    method: "post",
    path: "/api/instance/task-drain",
    tags: ["instance"],
    summary:
      "Acquire an owned finite drain lease that blocks new run admission across server recreation",
    request: { body: jsonBody(startTaskDrainRequestSchema) },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      409: r.conflict,
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/instance/task-drain",
    tags: ["instance"],
    summary: "Release the matching drain lease for its authenticated owner",
    description: "A missing lease or a mismatched owner or lease ID returns HTTP 409. Independent operator holds remain active.",
    request: { body: jsonBody(stopTaskDrainRequestSchema) },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 409: r.conflict },
  });
}
