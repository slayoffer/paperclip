import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Local run evidence. No tool arguments, paths, messages, or error text. */
export type LocalExecutionEvidence =
  | { kind: "ssh_phase"; attemptId: string; phase: "prepare" | "restore";
      boundary: "queued" | "started" | "ended"; at: string;
      outcome?: "succeeded" | "failed" }
  | { kind: "stop_request"; requestId: string; requestedAt: string;
      source: string; reason: string; initiator: { type: string; id?: string } }
  | { kind: "stop_result"; requestId: string; at: string; outcome: "returned" | "failed" };

export type LocalExecutionEvidenceSink = (event: LocalExecutionEvidence) => Promise<void>;
const evidence = new AsyncLocalStorage<LocalExecutionEvidenceSink>();

export function withLocalExecutionEvidence<T>(sink: LocalExecutionEvidenceSink, operation: () => Promise<T>): Promise<T> {
  return evidence.run(sink, operation);
}

/** Evidence failure must never prevent Stop, cleanup, or synchronization. */
export async function emitLocalExecutionEvidence(event: LocalExecutionEvidence): Promise<void> {
  try { await evidence.getStore()?.(event); } catch { /* The owner records storage failures. */ }
}

/** Record process-owned stops without delaying the first signal. */
export function beginLocalStopEvidence(reason: "timeout" | "terminal_cleanup" | "checkpoint_failure") {
  const requestId = randomUUID();
  void emitLocalExecutionEvidence({ kind: "stop_request", requestId, requestedAt: new Date().toISOString(),
    source: "control_plane", reason, initiator: { type: "system" } });
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    void emitLocalExecutionEvidence({ kind: "stop_result", requestId, at: new Date().toISOString(), outcome: "returned" });
  };
}
