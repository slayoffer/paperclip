import type { executionWorkspaceService } from "./execution-workspaces.js";

type SweepResult = Awaited<ReturnType<ReturnType<typeof executionWorkspaceService>["sweepTerminalWorkspaces"]>>;

export function createTerminalWorkspaceSweepReporter(
  logger: { info: (result: SweepResult, message: string) => void },
  now = Date.now,
) {
  let lastSkipLogAt: number | null = null;
  const skipLogIntervalMs = 10 * 60 * 1000;
  return (result: SweepResult) => {
    if (result.archived > 0 || result.cleanupFailed > 0 || result.clearedStaleReopenPending > 0) {
      logger.info(result, "terminal issue workspace reaper changed workspace state");
      return;
    }
    const nowMs = now();
    if (lastSkipLogAt !== null && nowMs - lastSkipLogAt < skipLogIntervalMs) return;
    lastSkipLogAt = nowMs;
    const message = result.skippedConcurrentSweep > 0
      ? "terminal issue workspace reaper skipped because another sweep still runs"
      : result.checked > 0
        ? "terminal issue workspace reaper skipped all candidates"
        : "terminal issue workspace reaper found no candidates";
    logger.info(result, message);
  };
}
