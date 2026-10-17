import { afterEach, describe, expect, it } from "vitest";
import { selfBlockGuardEnabled, skipSelfUnblockWake } from "./self-block-guard.js";

const saved = process.env.PAPERCLIP_SELF_BLOCK_GUARD;
afterEach(() => {
  if (saved === undefined) delete process.env.PAPERCLIP_SELF_BLOCK_GUARD;
  else process.env.PAPERCLIP_SELF_BLOCK_GUARD = saved;
});

describe("self-block guard", () => {
  const issue = (assignee: string, owner: unknown) => ({ assigneeAgentId: assignee, unblockDescriptor: { owner } });
  it("is off unless the switch is exactly true", () => {
    delete process.env.PAPERCLIP_SELF_BLOCK_GUARD;
    expect(selfBlockGuardEnabled()).toBe(false);
    expect(skipSelfUnblockWake(issue("a1", { agentId: "a1" }))).toBe(false);
  });
  it("skips the wake only when the owner is the issue's own assignee", () => {
    process.env.PAPERCLIP_SELF_BLOCK_GUARD = "true";
    expect(skipSelfUnblockWake(issue("a1", { agentId: "a1" }))).toBe(true);
    expect(skipSelfUnblockWake(issue("a1", { agentId: "a2" }))).toBe(false);
    expect(skipSelfUnblockWake(issue("a1", "board"))).toBe(false);
    expect(skipSelfUnblockWake({ assigneeAgentId: "a1", unblockDescriptor: null })).toBe(false);
  });
});
