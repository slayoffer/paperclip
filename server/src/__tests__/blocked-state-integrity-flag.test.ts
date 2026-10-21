import { describe, expect, it } from "vitest";
import { blockedStateIntegrityEnabled } from "../services/blocked-state-integrity.js";

describe("blocked-state integrity flag", () => {
  it("defaults to OFF when the environment has no flag", () => {
    expect(blockedStateIntegrityEnabled({})).toBe(false);
  });

  it.each(["false", "TRUE", "", "1"])("stays OFF for %j", value => {
    expect(blockedStateIntegrityEnabled({ PAPERCLIP_BLOCKED_STATE_INTEGRITY: value })).toBe(false);
  });

  it("enables integrity only for exact true", () => {
    expect(blockedStateIntegrityEnabled({ PAPERCLIP_BLOCKED_STATE_INTEGRITY: "true" })).toBe(true);
  });
});
