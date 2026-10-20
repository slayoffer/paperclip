import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../routes/openapi.js";

describe("company interaction read contract", () => {
  it("documents the mounted list route and its input filters", () => {
    const spec = buildOpenApiSpec();
    const operation = spec.paths["/api/companies/{companyId}/interactions"]!.get!;
    const parameters = operation.parameters as Array<{ name: string; in: string }>;
    expect(parameters.map(({ name, in: location }) => `${location}:${name}`).sort()).toEqual([
      "path:companyId", "query:cursor", "query:issueId", "query:kind", "query:limit", "query:status",
    ]);
    expect(Object.keys(operation.responses).sort()).toEqual(["200", "400", "401", "403"]);
    expect(spec.paths["/api/issues/{id}/interactions"]!.get).toBeDefined();
    expect(spec.paths["/api/issues/{id}/interactions/{interactionId}"]!.get).toBeDefined();
    expect(spec.paths["/api/companies/{companyId}/interaction-locations/{interactionId}"]!.get).toBeDefined();
  });
});
