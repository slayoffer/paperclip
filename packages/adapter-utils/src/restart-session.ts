import type { AdapterExecutionContext } from "./types.js";

export const RESTART_RESUME_PROMPT = "Paperclip restarted. Continue the task from where you stopped. Existing approvals still apply.";

/** Save the provider identity as soon as the CLI reports it, before its result. */
export function checkpointSessionOutput(input: {
  adapterType: "codex_local" | "claude_local";
  params: Record<string, unknown>;
  expectedSessionId?: string;
  onLog: AdapterExecutionContext["onLog"];
  onEvent: AdapterExecutionContext["onEvent"];
}): AdapterExecutionContext["onLog"] {
  let pending = "";
  let saved: string | null = null;
  return async (stream, chunk) => {
    if (stream === "stdout") {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        let event: Record<string, unknown>;
        try { event = JSON.parse(line); } catch { continue; }
        if (!event || typeof event !== "object") continue;
        const id = input.adapterType === "codex_local" && event.type === "thread.started"
          ? event.thread_id
          : input.adapterType === "claude_local" && event.type === "system" && event.subtype === "init"
            ? event.session_id : null;
        if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(id) || saved === id) continue;
        if (input.expectedSessionId && id !== input.expectedSessionId) throw new Error("restart_session_changed");
        await input.onEvent?.({ eventType: "session.checkpoint", stream: "system", level: "info",
          message: "Saved the provider session for restart recovery",
          payload: { adapterType: input.adapterType, sessionParams: { ...input.params, sessionId: id } } });
        saved = id;
      }
      // Diagnostic lines must not retain unbounded output without a newline.
      if (pending.length > 64 * 1024) pending = "";
    }
    await input.onLog(stream, chunk);
  };
}
