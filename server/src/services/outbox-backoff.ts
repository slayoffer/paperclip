/** Persist the deadline so process restarts cannot reset a held wake's retry rate. */
export function outboxBackoff(holdCount: number, at: Date) {
  return {
    holdCount: holdCount + 1,
    nextAttemptAt: new Date(at.getTime() + Math.min(30_000 * 2 ** Math.min(holdCount, 6), 1_800_000)),
  };
}
