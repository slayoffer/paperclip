// The terminal workspace reaper keeps the last "dirty" git verdict per
// workspace in process memory. A cached verdict only causes a skip. The archive
// path always runs a fresh git check. A restart clears the state.
export const TERMINAL_SWEEP_DIRTY_RECHECK_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

export function createTerminalWorkspaceDirtyVerdicts(now: () => Date) {
  const verdicts = new Map<string, { checkedAtMs: number; rowUpdatedAt: string }>();
  return {
    // Remove verdicts that outlived the interval, so the map stays small.
    prune() {
      const nowMs = now().getTime();
      for (const [id, verdict] of verdicts) {
        if (nowMs - verdict.checkedAtMs >= TERMINAL_SWEEP_DIRTY_RECHECK_MS) verdicts.delete(id);
      }
    },
    // True while the workspace row is unchanged and the interval has not ended.
    shouldSkip(id: string, rowUpdatedAt: string) {
      const verdict = verdicts.get(id);
      return Boolean(
        verdict
        && verdict.rowUpdatedAt === rowUpdatedAt
        && now().getTime() - verdict.checkedAtMs < TERMINAL_SWEEP_DIRTY_RECHECK_MS,
      );
    },
    recordDirty(id: string, rowUpdatedAt: string) {
      verdicts.delete(id);
      verdicts.set(id, { checkedAtMs: now().getTime(), rowUpdatedAt });
      while (verdicts.size > MAX_ENTRIES) {
        const oldest = verdicts.keys().next().value;
        if (oldest === undefined) break;
        verdicts.delete(oldest);
      }
    },
    forget(id: string) {
      verdicts.delete(id);
    },
  };
}
