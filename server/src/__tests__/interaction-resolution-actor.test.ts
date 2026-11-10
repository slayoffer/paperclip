import { describe, expect, it } from "vitest";
import { resolutionViaFromActor } from "../routes/interaction-resolution-actor.js";

describe("interaction authentication channel", () => {
  const keyId = "ea6557da-2200-4cf4-bb67-24c5c8cafcbb";
  it.each([
    ["session", "user_session"], ["board_key", "board_api_key"],
    ["agent_key", "agent_key"], ["agent_jwt", "agent_key"],
  ] as const)("classifies authenticated source %s", (source, resolvedVia) => {
    expect(resolutionViaFromActor({ source, keyId })).toEqual({
      resolvedVia, resolvedViaKeyId: source === "board_key" ? keyId : null,
    });
  });
  it.each(["local_implicit", "cloud_tenant", "cloud_control", "mcp_oauth", "none", undefined] as const)(
    "keeps unmapped source %s unknown", (source) => {
      expect(resolutionViaFromActor({ source, keyId })).toBeNull();
    },
  );
  it("keeps a board source without authenticated key identity unknown", () => {
    expect(resolutionViaFromActor({ source: "board_key" })).toBeNull();
  });
});
