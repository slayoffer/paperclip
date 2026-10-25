import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../routes/openapi.js";

describe("task drain OpenAPI contract", () => {
  it("documents persisted status, matching lease release, and conflicts", () => {
    const paths = buildOpenApiSpec().paths["/api/instance/task-drain"]!;
    expect(paths.get!.summary).toContain("survives server recreation");
    expect(paths.get!.description).toContain("persisted running, queued, scheduled-retry, and pending wake records");
    expect(paths.post!.responses["409"]).toBeDefined();
    expect(paths.delete!.responses["409"]).toBeDefined();
    expect(paths.delete!.responses["400"]).toBeDefined();
    expect(paths.delete!.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: { type: "object", required: ["leaseId"], properties: { leaseId: { type: "string", format: "uuid" } } },
        },
      },
    });
  });
});
