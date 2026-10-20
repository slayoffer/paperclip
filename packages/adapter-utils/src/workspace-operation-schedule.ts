import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { RuntimeProgressSink } from "./runtime-progress.js";

/** Preparation and restore share a process-wide first-in, first-out queue. */
export class WorkspaceOperationSchedule {
  private active = 0;
  private waiting: Array<() => void> = [];
  private scope = new AsyncLocalStorage<{ active: boolean }>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Workspace operation limit must be positive");
  }

  ownsCurrentSlot(): boolean {
    return this.scope.getStore()?.active === true;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    // Asset failure recovery can restore within an active preparation slot.
    if (this.scope.getStore()?.active) return operation();
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active += 1;
    const lease = { active: true };
    try { return await this.scope.run(lease, operation); }
    finally {
      lease.active = false;
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

// This limits workspace I/O, not running agents or their leases.
export const sshWorkspaceOperations = new WorkspaceOperationSchedule(2);

export async function timeWorkspaceStep<T>(
  sink: RuntimeProgressSink | undefined,
  step: string,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  await sink?.(`[paperclip] ${step} started.\n`);
  let state = "failed";
  try {
    const result = await operation();
    state = "completed";
    return result;
  } finally {
    await sink?.(`[paperclip] ${step} ${state} in ${Math.round(performance.now() - started)} ms.\n`);
  }
}

export async function scheduleSshWorkspaceOperation<T>(
  sink: RuntimeProgressSink | undefined,
  phase: "prepare" | "restore",
  operation: () => Promise<T>,
): Promise<T> {
  if (sshWorkspaceOperations.ownsCurrentSlot()) return operation();
  const queued = performance.now();
  await sink?.(`[paperclip] SSH workspace ${phase} queued.\n`);
  return sshWorkspaceOperations.run(async () => {
    await sink?.(`[paperclip] SSH workspace ${phase} admitted after ${Math.round(performance.now() - queued)} ms.\n`);
    return timeWorkspaceStep(sink, `SSH workspace ${phase}`, operation);
  });
}
