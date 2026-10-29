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
    skipUntil(id: string, rowUpdatedAt: string): number | null {
      const verdict = verdicts.get(id);
      if (!verdict || verdict.rowUpdatedAt !== rowUpdatedAt) return null;
      const recheckAt = verdict.checkedAtMs + TERMINAL_SWEEP_DIRTY_RECHECK_MS;
      return recheckAt > now().getTime() ? recheckAt : null;
    },
    recordDirty(id: string, rowUpdatedAt: string) {
      verdicts.delete(id);
      const checkedAtMs = now().getTime();
      verdicts.set(id, { checkedAtMs, rowUpdatedAt });
      while (verdicts.size > MAX_ENTRIES) {
        const oldest = verdicts.keys().next().value;
        if (oldest === undefined) break;
        verdicts.delete(oldest);
      }
      return checkedAtMs + TERMINAL_SWEEP_DIRTY_RECHECK_MS;
    },
    forget(id: string) {
      verdicts.delete(id);
    },
  };
}
