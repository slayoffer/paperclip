import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../routes/openapi.js";

describe("run statistics OpenAPI contract", () => {
  it("documents the board-only agent statistics grant and strict request", () => {
    const path = buildOpenApiSpec().paths["/api/companies/{companyId}/agents/{agentId}/permission-grants"];
    expect(Object.keys(path)).toEqual(["post"]);
    expect(path.post.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    expect(path.post.description).toContain("users:manage_permissions");
    const body = path.post.requestBody.content["application/json"].schema;
    expect(body.additionalProperties).toBe(false);
    expect(body.required).toEqual(["permissionKey"]);
    expect(body.properties.permissionKey.enum).toEqual(["stats:read"]);
    expect(Object.keys(path.post.responses).sort()).toEqual(["200", "400", "401", "403", "404", "409"]);
  });
  it("documents the bounded query, access rules, count response, and errors", () => {
    const path = buildOpenApiSpec().paths["/api/companies/{companyId}/run-stats"];
    expect(Object.keys(path)).toEqual(["get"]);
    const operation = path.get;
    expect(operation.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
      { AgentBearerAuth: [] },
    ]);
    for (const text of ["stats:read", "14 days", "inclusive", "exclusive", "60 seconds", "literal matching"]) {
      expect(operation.description).toContain(text);
    }
    expect(operation.requestBody).toBeUndefined();
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "companyId", in: "path", required: true, schema: { type: "string", format: "uuid" } }),
      expect.objectContaining({ name: "from", in: "query", required: true, schema: { type: "string", format: "date-time" } }),
      expect.objectContaining({ name: "to", in: "query", required: true, schema: { type: "string", format: "date-time" } }),
      expect.objectContaining({ name: "bucket", in: "query", required: false, schema: { type: "string", enum: ["hour"] } }),
      expect.objectContaining({ name: "groupBy", in: "query", required: false, schema: { type: "string", enum: ["status", "errorCode", "agentId"] } }),
      expect.objectContaining({ name: "errorCode", in: "query", required: false, schema: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,95}$" } }),
    ]));
    expect(Object.keys(operation.responses).sort()).toEqual(["200", "400", "401", "403", "422", "429", "503"]);
    const report = operation.responses["200"].content["application/json"].schema;
    expect(report.additionalProperties).toBe(false);
    expect(Object.keys(report.properties).sort()).toEqual([
      "bucket", "companyId", "errorCode", "from", "groupBy", "matchingTotal", "rows", "to", "total",
    ]);
    expect(report.properties.total).toEqual({ type: "integer", minimum: 0 });
    expect(report.properties.matchingTotal).toMatchObject({ type: "integer", nullable: true });
    expect(report.properties.rows.items.additionalProperties).toBe(false);
    expect(Object.keys(report.properties.rows.items.properties).sort()).toEqual(["bucket", "count", "group", "matchingCount"]);
    expect(report.properties.rows.items.properties.matchingCount).toMatchObject({ type: "integer", nullable: true });
  });
});
