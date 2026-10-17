import { describe, expect, it } from "vitest";
import { maxRunningRunsCap } from "../services/heartbeat.js";

describe("instance running-run cap", () => {
  it("is off unless a positive integer", () => {
    expect(maxRunningRunsCap({})).toBeNull();
    expect(maxRunningRunsCap({ PAPERCLIP_MAX_RUNNING_RUNS: "0" })).toBeNull();
    expect(maxRunningRunsCap({ PAPERCLIP_MAX_RUNNING_RUNS: "six" })).toBeNull();
    expect(maxRunningRunsCap({ PAPERCLIP_MAX_RUNNING_RUNS: " 6 " })).toBe(6);
  });
});
