import { z } from "zod";
import { createCredentialTransferSchema } from "@paperclipai/shared";
import type { OpenApiPathRegistration, OpenApiResponse } from "./openapi-types.js";

type Responses = { ok: (schema: z.ZodTypeAny) => OpenApiResponse }
  & Record<"badRequest" | "unauthorized" | "forbidden" | "conflict" | "unprocessable" | "serverError", OpenApiResponse>;

export function registerCredentialTransferPaths(registry: { registerPath(path: OpenApiPathRegistration): void }, r: Responses) {
  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/credential-transfers",
    tags: ["credential-transfers"],
    summary: "Execute an approved bounded credential transfer",
    description: "Requires an authenticated agent, a responsible person, and a gateway session. No production provider is registered.",
    request: {
      body: { required: true, content: { "application/json": { schema: createCredentialTransferSchema } } },
    },
    parameters: [
      { in: "path", name: "companyId", required: true, schema: { type: "string", format: "uuid" } },
      { in: "header", name: "x-paperclip-tool-gateway-token", required: true, schema: { type: "string" } },
    ],
    responses: {
      201: r.ok(z.object({
        id: z.string().uuid(),
        state: z.enum(["complete", "revoked", "cleanup_required"]),
        credentialId: z.string().nullable(),
        storedNames: z.array(z.enum(["CLPN_R2_MONITOR_ACCESS_KEY_ID", "CLPN_R2_MONITOR_SECRET_ACCESS_KEY"])),
        failureCode: z.string().nullable(),
      })),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      409: r.conflict,
      422: r.unprocessable,
      500: r.serverError,
      503: { description: "No credential-transfer provider is registered" },
    },
  });
}
