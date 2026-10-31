import { describe, expect, it, vi } from "vitest";
import { readRunTokenCapConfig, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createRunTokenCapTracker, executeWithRunTokenCap } from "./run-token-cap.js";

const turn = (input_tokens: number) => ({ type: "turn.completed", usage: { input_tokens } });

describe("Codex run token cap", () => {
  it("sums cumulative deltas once, including counter resets and cached input", () => {
    const tracker = createRunTokenCapTracker(500);
    for (const event of [turn(600), turn(600), turn(800), turn(50)]) tracker.event(event);
    expect(tracker.snapshot()).toEqual({ inputTokens: 350, boundary: true });
  });

  it("waits until turn.completed and never admits a stop during a tool call", () => {
    const tracker = createRunTokenCapTracker();
    tracker.event({ type: "item.started", item: { type: "command_execution" } });
    tracker.event({ type: "item.completed", item: { type: "command_execution" }, usage: { input_tokens: 999 } });
    expect(tracker.snapshot()).toEqual({ inputTokens: 0, boundary: false });
    tracker.event(turn(200));
    expect(tracker.snapshot()).toEqual({ inputTokens: 200, boundary: true });
    tracker.event({ type: "turn.started" });
    expect(tracker.snapshot().boundary).toBe(false);
  });

  it.each([undefined, "off", "invalid", "ENFORCE"])("leaves mode %s off", (mode) => {
    expect(readRunTokenCapConfig({ PAPERCLIP_RUN_TOKEN_CAP_MODE: mode, PAPERCLIP_RUN_TOKEN_CAP_INPUT_TOKENS: "100" })).toBeNull();
  });

  it.each([undefined, "", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"])("rejects invalid cap %s", (limit) => {
    expect(readRunTokenCapConfig({ PAPERCLIP_RUN_TOKEN_CAP_MODE: "enforce", PAPERCLIP_RUN_TOKEN_CAP_INPUT_TOKENS: limit })).toBeNull();
  });

  async function invoke(mode: string, options: { total?: number; baseline?: number; failed?: boolean; incomplete?: boolean } = {}) {
    vi.stubEnv("PAPERCLIP_RUN_TOKEN_CAP_MODE", mode);
    vi.stubEnv("PAPERCLIP_RUN_TOKEN_CAP_INPUT_TOKENS", "100");
    const result: AdapterExecutionResult = {
      exitCode: options.failed ? 1 : 0, signal: null, timedOut: false,
      usageBasis: "session_cumulative", sessionId: "thread-1", summary: "Done: A. Left: B. Next: test B.",
      sessionParams: { sessionId: "thread-1" },
      resultJson: { stdout: JSON.stringify(options.incomplete
        ? { type: "item.started", item: { type: "command_execution" } }
        : turn(options.total ?? 101)) },
    };
    const onLog = vi.fn();
    const ctx = { onLog, context: { paperclipRunTokenCapBaseline: {
      sessionId: "thread-1", inputTokens: options.baseline ?? 0,
    } } } as unknown as AdapterExecutionContext;
    let providerStopped = false;
    const execute = vi.fn(async () => { providerStopped = true; return result; });
    onLog.mockImplementation(() => { expect(providerStopped).toBe(true); });
    try { return { result, actual: await executeWithRunTokenCap(ctx, execute), onLog, execute }; }
    finally { vi.unstubAllEnvs(); }
  }

  it("returns the identical result and does not log when off", async () => {
    const { result, actual, onLog, execute } = await invoke("off");
    expect(actual).toBe(result);
    expect(onLog).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("records a dry run without a stop or a new invocation", async () => {
    const { actual, onLog, execute } = await invoke("dry_run");
    expect(actual.resultJson?.stopReason).toBeUndefined();
    expect(actual.resultJson?.runTokenCap).toMatchObject({ mode: "dry_run", inputTokens: 101 });
    expect(onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("would stop"));
    expect(execute).toHaveBeenCalledOnce();
  });

  it("marks a clean turn with a typed stop and preserves the session and handoff text", async () => {
    const { actual, result } = await invoke("enforce");
    expect(actual).toMatchObject({ exitCode: 0, signal: null, timedOut: false, sessionId: "thread-1" });
    expect(actual.errorMessage).toBeUndefined();
    expect(actual.resultJson?.stopReason).toBe("run_token_cap");
    expect(actual.summary).toBe(result.summary);
    expect(actual.sessionParams).toBe(result.sessionParams);
  });

  it.each([{ total: 100 }, { total: 1000, baseline: 950 }, { failed: true }, { incomplete: true }])(
    "does not mark equality, historical usage, failure, or an unfinished tool as a cap stop: %j", async (options) => {
      const { actual, result, onLog } = await invoke("enforce", options);
      expect(actual).toBe(result);
      expect(onLog).not.toHaveBeenCalled();
    },
  );
});
