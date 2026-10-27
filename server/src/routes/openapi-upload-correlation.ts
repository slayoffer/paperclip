import { z } from "zod";
import { uploadCorrelationQuerySchema } from "@paperclipai/shared";
import type { OpenApiPathRegistration, OpenApiResponse } from "./openapi-types.js";

type Responses = {
  ok: (schema: z.ZodTypeAny) => OpenApiResponse;
} & Record<"badRequest" | "unauthorized" | "forbidden" | "notFound", OpenApiResponse>;

export function registerUploadCorrelationPaths(
  registry: { registerPath(path: OpenApiPathRegistration): void },
  r: Responses,
) {
  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/issues/{issueId}/attachment-upload-correlation",
    tags: ["assets"],
    summary: "Correlate one original attachment upload without another upload",
    description: [
      "Board callers require company access and separate audit:view_agent_actions authority. Local implicit callers and instance administrators retain audit authority.",
      "The original run must belong to this company and issue. Operation and object selectors must match exact receipt evidence.",
      "Byte verification requires verifyBytes=true and remains subject to the recorded length, storage limit, and 30-second deadline.",
      "Missing historical receipts or attachments return incomplete evidence. They do not prove that stored objects are absent.",
      "The operation preserves stored objects and performs no upload, reference repair, or bucket listing.",
    ].join(" "),
    security: [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }],
    "x-paperclip-authorization": { actor: "board" },
    request: {
      params: z.object({ companyId: z.string().uuid(), issueId: z.string().uuid() }),
      query: uploadCorrelationQuerySchema,
    },
    responses: {
      200: r.ok(z.object({
        outcome: z.enum(["verified_bytes", "incomplete_evidence", "access_denied", "operation_absent"]),
        operationId: z.string().uuid().nullable(),
        objectBinding: z.object({
          provider: z.string(),
          bindingId: z.string(),
          objectKey: z.string(),
        }).strict().nullable(),
        registration: z.enum(["registered", "unresolved", "not_started"]),
        attachmentId: z.string().uuid().nullable(),
        expectedByteSize: z.number().int().nonnegative().nullable(),
        expectedSha256: z.string().nullable(),
        actualByteSize: z.number().int().nonnegative().nullable(),
        actualSha256: z.string().nullable(),
        reason: z.string(),
      }).strict()),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });
}
