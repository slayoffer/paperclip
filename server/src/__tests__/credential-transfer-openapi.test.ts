import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../routes/openapi.js";

describe("credential transfer API contract", () => {
  it("requires the company, gateway header, and bounded request with a redacted receipt", () => {
    const operation = buildOpenApiDocument().paths["/api/companies/{companyId}/credential-transfers"].post;
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "path", name: "companyId", required: true }),
      expect.objectContaining({ in: "header", name: "x-paperclip-tool-gateway-token", required: true }),
    ]));
    expect(operation.requestBody.required).toBe(true);
    expect(Object.keys(operation.requestBody.content["application/json"].schema.properties)).toEqual([
      "issueId", "source", "destination", "permissionApproval", "issuanceApproval",
    ]);
    expect(Object.keys(operation.responses["201"].content["application/json"].schema.properties)).toEqual([
      "id", "state", "credentialId", "storedNames", "failureCode",
    ]);
    expect(operation.responses["503"]).toBeDefined();
  });
});
