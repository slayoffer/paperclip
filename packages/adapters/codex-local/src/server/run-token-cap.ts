import {
  RUN_TOKEN_CAP, readRunTokenCapConfig,
  type AdapterExecutionContext, type AdapterExecutionResult, type RunTokenCapReceipt,
} from "@paperclipai/adapter-utils";

/** Exec reports cumulative usage only at the end of an agentic turn. */
export function createRunTokenCapTracker(baseline = 0) {
  let previous = baseline;
  let inputTokens = 0;
  let boundary = false;
  return {
    event(event: Record<string, unknown>) {
      if (["turn.started", "turn.failed", "error", "item.started"].includes(String(event.type))) boundary = false;
      if (event.type !== "turn.completed") return;
      const total = (event.usage as Record<string, unknown> | undefined)?.input_tokens;
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) return;
      // Sum deltas, not session totals. A reset starts a new counter segment.
      inputTokens += total >= previous ? total - previous : total;
      previous = total;
      boundary = true;
    },
    snapshot: () => ({ inputTokens, boundary }),
  };
}

export async function executeWithRunTokenCap(
  ctx: AdapterExecutionContext,
  execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>,
): Promise<AdapterExecutionResult> {
  const config = readRunTokenCapConfig();
  if (!config) return execute(ctx);
  const result = await execute(ctx);
  // Use the accepted attempt only. Setup logs and failed resume attempts are not turns.
  const stdout = result.resultJson?.stdout;
  if (typeof stdout !== "string" || result.usageBasis !== "session_cumulative") return result;
  const baseline = ctx.context.paperclipRunTokenCapBaseline as { sessionId: string; inputTokens: number } | undefined;
  const tracker = createRunTokenCapTracker(
    baseline && baseline.sessionId === result.sessionId ? baseline.inputTokens : 0,
  );
  for (const line of stdout.split(/\r?\n/)) {
    try { tracker.event(JSON.parse(line)); } catch { /* Non-protocol lines carry no usage. */ }
  }
  const { inputTokens, boundary } = tracker.snapshot();
  if (!boundary || inputTokens <= config.limit || result.exitCode !== 0 || result.signal || result.timedOut || result.errorMessage) return result;
  const receipt: RunTokenCapReceipt = { ...config, inputTokens, boundary: "turn.completed" };
  await ctx.onLog("stderr", `[paperclip] ${RUN_TOKEN_CAP}: ${inputTokens} input tokens exceed ${config.limit}. ` +
    `${config.mode === "dry_run" ? "would stop" : "stopped"} at turn.completed after clean process exit.\n`);
  return {
    ...result,
    resultJson: {
      ...result.resultJson,
      runTokenCap: receipt,
      ...(config.mode === "enforce" ? { stopReason: RUN_TOKEN_CAP } : {}),
    },
  };
}
