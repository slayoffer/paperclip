import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../routes/openapi.js";

type ReadSchema = { items?: ReadSchema; properties?: Record<string, ReadSchema>; required?: string[] };

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

  it.each([
    "/api/issues/{id}/interactions",
    "/api/issues/{id}/interactions/{interactionId}",
    "/api/companies/{companyId}/interactions",
  ])("documents saved channel and board key identity on %s", (path) => {
    const operation = buildOpenApiSpec().paths[path]!.get!;
    const response = operation.responses["200"] as {
      content: { "application/json": { schema: ReadSchema } };
    };
    const schema = response.content["application/json"].schema;
    const card = path.includes("companies") ? schema.properties!.items!.items! : schema.items ?? schema;
    expect(card.required).toContain("resolvedVia");
    expect(card.required).toContain("resolvedViaKeyId");
    expect(card.properties!.resolvedVia).toMatchObject({
      nullable: true, enum: ["user_session", "board_api_key", "agent_key", "chat_channel", "system"],
    });
    expect(card.properties!.resolvedViaKeyId).toMatchObject({ nullable: true, type: "string", format: "uuid" });
  });
});
