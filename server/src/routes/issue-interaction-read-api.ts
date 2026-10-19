import { z } from "zod";

const issueReads = [
  "/api/issues/{id}/interactions",
  "/api/issues/{id}/interactions/{interactionId}",
].map((path) => ({
  method: "get" as const,
  path,
  tags: ["issues"],
  summary: path.endsWith("{interactionId}")
    ? "Read a saved issue thread interaction"
    : "List issue thread interactions",
  description: "Read saved status, payload target revision, and authenticated resolver fields. Issue and company authorization apply. A read does not resolve a card or grant authority.",
  request: { params: z.object({
    id: z.string(),
    ...(path.endsWith("{interactionId}") ? { interactionId: z.string() } : {}),
  }) },
  responses: {
    200: { description: "Saved interaction evidence", content: { "application/json": { schema: {} } } },
    401: { description: "Authentication required" },
    403: { description: "Issue access denied" },
    404: { description: "Issue or interaction not found" },
  },
}));

export const issueInteractionReadApiPaths = [
  ...issueReads,
  {
    method: "get" as const,
    path: "/api/companies/{companyId}/interaction-locations/{interactionId}",
    tags: ["issues"],
    summary: "Locate a readable saved interaction within a company",
    request: { params: z.object({ companyId: z.string(), interactionId: z.string() }) },
    responses: {
      200: { description: "Versioned issue location without card contents", content: { "application/json": { schema: {} } } },
      401: { description: "Authentication required" },
      403: { description: "Company or issue access denied" },
      404: { description: "Interaction not found" },
    },
  },
];
