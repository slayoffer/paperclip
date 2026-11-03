import { describe, expect, it, vi } from "vitest";
import type { heartbeatRuns } from "@paperclipai/db";
import { SshTransportError } from "@paperclipai/adapter-utils/ssh-transport";
import { deferSshSetupFailure } from "./ssh-setup-deferral.js";
import { createHeartbeatRunCompletion, type FailHeartbeatRunInput } from "./run-completion.js";

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

  it("finalizes the opened log before the setup deferral returns", async () => {
    const calls: string[] = [];
    const run = { id: "run", runtimeMode: "legacy" } as typeof heartbeatRuns.$inferSelect;
    const output = {
      handle: { store: "local_file", logRef: "test-log" },
      flushRunLog: vi.fn(async () => { calls.push("flush"); }),
      outputProgressState: { pending: { bytes: 1 } },
      flushOutputProgress: vi.fn(async () => { calls.push("progress"); }),
    };
    const finalize = vi.fn(async () => {
      calls.push("finalize");
      return { bytes: 123, compressed: false };
    });
    const setRunStatusIfRunning = vi.fn(async () => {
      calls.push("cancel");
      return { updated: false, run: null };
    });
    const completion = createHeartbeatRunCompletion({} as never, {
      processRunCancellationSettlements: new Map(), runLogStore: { finalize }, setRunStatusIfRunning,
    } as never);
    await completion.failRun({ run, output, session: {}, legacyAdapterEntered: false,
      err: new SshTransportError(new Error("timeout")),
    } as FailHeartbeatRunInput);
    expect(calls).toEqual(["flush", "finalize", "progress", "cancel"]);
    expect(finalize).toHaveBeenCalledWith(output.handle);
    expect(output.outputProgressState.pending.bytes).toBe(123);
    expect(output.flushOutputProgress).toHaveBeenCalledWith({ force: true });
  });
});
