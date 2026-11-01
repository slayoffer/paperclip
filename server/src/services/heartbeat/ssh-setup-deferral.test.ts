import { describe, expect, it, vi } from "vitest";
import type { heartbeatRuns } from "@paperclipai/db";
import { SshTransportError } from "@paperclipai/adapter-utils/ssh-transport";
import { deferSshSetupFailure } from "./ssh-setup-deferral.js";

describe("SSH setup deferral", () => {
  it("ignores remote command failures", async () => {
    const deps = new Proxy({}, { get: () => { throw new Error("Unexpected callback"); } });
    expect(await deferSshSetupFailure({} as typeof heartbeatRuns.$inferSelect,
      Object.assign(new Error("Connection reset"), { code: 23 }), deps as never)).toBe(false);
  });

  it("does not overwrite a cancellation", async () => {
    const setRunStatusIfRunning = vi.fn(async () => ({ updated: false, run: null }));
    expect(await deferSshSetupFailure({ id: "run" } as typeof heartbeatRuns.$inferSelect,
      new SshTransportError(new Error("timeout")), { setRunStatusIfRunning } as never)).toBe(true);
    expect(setRunStatusIfRunning).toHaveBeenCalledWith("run", "cancelled", expect.any(Object));
  });
});
