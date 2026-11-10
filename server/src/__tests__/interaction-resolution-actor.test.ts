import { describe, expect, it } from "vitest";
import { interactionResolvedVia } from "../routes/interaction-resolution-actor.js";

describe("interaction authentication channel", () => {
  it.each([
    ["session", "user_session"], ["board_key", "board_api_key"],
    ["local_implicit", null], ["cloud_tenant", null], ["mcp_oauth", null], [undefined, null],
  ] as const)("classifies board source %s without inferring from userId", (source, expected) => {
    expect(interactionResolvedVia({ type: "board", source, userId: "same-user" })).toBe(expected);
  });
  it.each(["agent_key", "agent_jwt"] as const)("classifies %s as agent_key", (source) => {
    expect(interactionResolvedVia({ type: "agent", source, agentId: "agent" })).toBe("agent_key");
  });
  it("does not trust a channel without its matching authenticated actor type", () => {
    expect(interactionResolvedVia({ type: "none", source: "session" })).toBeNull();
    expect(interactionResolvedVia({ type: "agent", source: "session" })).toBeNull();
  });
});
