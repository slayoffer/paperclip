import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../routes/openapi.js";

describe("upload correlation OpenAPI contract", () => {
  it("documents separate board audit authority and exact run selectors", () => {
    const spec = buildOpenApiSpec() as any;
    const operation = spec.paths[
      "/api/companies/{companyId}/issues/{issueId}/attachment-upload-correlation"
    ].get;

    expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
    expect(operation.description).toContain("audit:view_agent_actions");
    expect(operation.description).toContain("They do not prove that stored objects are absent");
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "companyId", in: "path", required: true }),
      expect.objectContaining({ name: "issueId", in: "path", required: true }),
      expect.objectContaining({ name: "runId", in: "query", required: true, schema: { type: "string", format: "uuid" } }),
      expect.objectContaining({ name: "operationId", in: "query", required: false }),
      expect.objectContaining({ name: "objectKey", in: "query", required: false }),
      expect.objectContaining({ name: "verifyBytes", in: "query", required: false }),
    ]));
    expect(Object.keys(operation.responses).sort()).toEqual(["200", "400", "401", "403", "404"]);

    const response = operation.responses["200"].content["application/json"].schema;
    expect(response.additionalProperties).toBe(false);
    expect(response.properties.outcome.enum).toEqual([
      "verified_bytes", "incomplete_evidence", "access_denied", "operation_absent",
    ]);
    for (const field of ["operationId", "objectBinding", "attachmentId", "expectedByteSize", "expectedSha256", "actualByteSize", "actualSha256"]) {
      expect(response.properties[field].nullable, field).toBe(true);
    }
  });
});
