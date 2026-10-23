import { describe, expect, it, vi } from "vitest";
import { checkpointSessionOutput } from "./restart-session.js";

describe("live CLI session checkpoints", () => {
  it.each([
    ["codex_local", '{"type":"thread.started","thread_id":"thread-1"}\n'],
    ["claude_local", '{"type":"system","subtype":"init","session_id":"thread-1"}\n'],
  ] as const)("saves a %s session before forwarding its split output", async (adapterType, line) => {
    const onLog = vi.fn(), onEvent = vi.fn();
    const log = checkpointSessionOutput({ adapterType, params: { cwd: "/workspace" }, onLog, onEvent });
    await log("stdout", line.slice(0, 12));
    expect(onEvent).not.toHaveBeenCalled();
    await log("stdout", line.slice(12));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "session.checkpoint", payload: { adapterType, sessionParams: { cwd: "/workspace", sessionId: "thread-1" } },
    }));
    expect(onEvent.mock.invocationCallOrder[0]).toBeLessThan(onLog.mock.invocationCallOrder[1]);
    await log("stdout", line);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("ignores stderr, nested tool data, invalid JSON, and oversized lines", async () => {
    const onEvent = vi.fn();
    const log = checkpointSessionOutput({ adapterType: "codex_local", params: {}, onLog: vi.fn(), onEvent });
    await log("stderr", '{"type":"thread.started","thread_id":"wrong"}\n');
    await log("stdout", '{"type":"item.completed","item":{"type":"thread.started","thread_id":"wrong"}}\nnull\n');
    await log("stdout", "x".repeat(70_000));
    await log("stdout", "\n");
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("does not discard a failed durable checkpoint", async () => {
    const onLog = vi.fn();
    const log = checkpointSessionOutput({ adapterType: "codex_local", params: {}, onLog,
      onEvent: vi.fn().mockRejectedValue(new Error("database unavailable")) });
    await expect(log("stdout", '{"type":"thread.started","thread_id":"thread-1"}\n'))
      .rejects.toThrow("database unavailable");
    expect(onLog).not.toHaveBeenCalled();
  });

  it("refuses a replacement session during restart recovery", async () => {
    const log = checkpointSessionOutput({ adapterType: "codex_local", params: {},
      expectedSessionId: "original-thread", onLog: vi.fn(), onEvent: vi.fn() });
    await expect(log("stdout", '{"type":"thread.started","thread_id":"new-thread"}\n'))
      .rejects.toThrow("restart_session_changed");
  });
});
