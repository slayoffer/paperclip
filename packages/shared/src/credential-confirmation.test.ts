import { describe, expect, it } from "vitest";
import {
  createIssueThreadInteractionSchema,
  requestConfirmationPayloadSchema,
} from "./validators/issue.js";

describe("confirmation credential marker", () => {
  it.each([true, false])("preserves credentialOperation=%s", (credentialOperation) => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "request_confirmation",
      resolverPolicy: "human_only",
      payload: { version: 1, prompt: "Approve the credential operation?", credentialOperation },
    });
    expect(parsed.payload).toHaveProperty("credentialOperation", credentialOperation);
    expect(requestConfirmationPayloadSchema.parse(parsed.payload))
      .toHaveProperty("credentialOperation", credentialOperation);
  });

  it("keeps existing confirmation payloads compatible", () => {
    const parsed = requestConfirmationPayloadSchema.parse({ version: 1, prompt: "Proceed?" });
    expect(parsed).not.toHaveProperty("credentialOperation");
  });

  it.each(["true", "false", 1, 0, null, {}, []].map((value) => ({ value })))("rejects invalid marker $value", ({ value }) => {
    expect(createIssueThreadInteractionSchema.safeParse({
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Proceed?", credentialOperation: value },
    }).success).toBe(false);
  });
});
