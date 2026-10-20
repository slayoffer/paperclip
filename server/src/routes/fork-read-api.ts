import { z } from "zod";
import { issueInteractionReadApiPaths } from "./issue-interaction-read-api.js";

export const forkReadApiPaths = [
  ...issueInteractionReadApiPaths,
  {
    method: "get" as const,
    path: "/api/companies/{companyId}/flow",
    tags: ["companies"],
    summary: "Read the company flow report",
    "x-paperclip-authorization": { actor: "board" },
    security: [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }],
    request: { params: z.object({ companyId: z.string() }) },
    responses: {
      200: { description: "Company flow report", content: { "application/json": { schema: {} } } },
      401: { description: "Authentication required" },
      403: { description: "Board and company access required" },
    } as Record<string, Record<string, unknown>>,
  },
];
