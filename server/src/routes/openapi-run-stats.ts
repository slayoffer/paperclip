import { z } from "zod";
import { runStatsQuerySchema } from "@paperclipai/shared/run-stats";
import type { OpenApiPathRegistration, OpenApiResponse } from "./openapi-types.js";

type Responses = {
  ok: (schema: z.ZodTypeAny) => OpenApiResponse;
} & Record<"badRequest" | "unauthorized" | "forbidden" | "unprocessable" | "tooManyRequests" | "serverError", OpenApiResponse>;

export function registerRunStatsPaths(
  registry: { registerPath(path: OpenApiPathRegistration): void },
  r: Responses,
) {
  const count = z.number().int().nonnegative();
  const report = z.object({
    companyId: z.string().uuid(),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    bucket: z.literal("hour"),
    groupBy: z.enum(["status", "errorCode", "agentId"]),
    errorCode: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,95}$/).optional(),
    total: count,
    matchingTotal: count.nullable(),
    rows: z.array(z.object({
      bucket: z.string().datetime(),
      group: z.string().nullable(),
      count,
      matchingCount: count.nullable(),
    }).strict()).max(10_000),
  }).strict();

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/run-stats",
    tags: ["activity"],
    summary: "Read company run counts by hour",
    description: [
      "Board callers need company access. Agents also need an active company membership and an explicit stats:read grant.",
      "Use a positive range of at most 14 days. The created_at start is inclusive and the end is exclusive.",
      "Buckets use UTC hours. Partial hours retain the requested boundaries. Each bucket can remain cached for 60 seconds.",
      "Group counts by status, error code, or agent identifier. Only counts and grouping metadata enter the response.",
      "The optional errorCode query uses literal matching against error_code, error, result_json.errorMessage, and result_json.error.",
      "Totals include all runs. Matching counts are null without errorCode. No run bodies, transcripts, or issue content enter the response.",
      "A group limit returns 422. Admission limits return 429. A five-second database timeout returns 503.",
    ].join(" "),
    request: {
      params: z.object({ companyId: z.string().uuid() }),
      query: runStatsQuerySchema,
    },
    responses: {
      200: r.ok(report),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      422: r.unprocessable,
      429: r.tooManyRequests,
      503: { ...r.serverError, description: "Run statistics query timed out. Use a shorter range." },
    },
  });
}
