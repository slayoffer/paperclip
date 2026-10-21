/** Independent durable queues must not block one another. Each queue remains
 * single-flight. Later sweeps observe committed transitions from their peers. */
export function createExecutionControlSweeper(input: {
  stopped: () => boolean;
  queues: ReadonlyArray<readonly [string, () => unknown]>;
  track: (work: Promise<unknown>) => void;
  onError: (error: unknown, queue: string) => void;
}) {
  const inFlight = new Set<string>();
  return () => {
    if (input.stopped()) return;
    for (const [queue, work] of input.queues) {
      if (inFlight.has(queue)) continue;
      inFlight.add(queue);
      input.track(Promise.resolve().then(async () => { await work(); })
        .catch(error => input.onError(error, queue))
        .finally(() => { inFlight.delete(queue); }));
    }
  };
}
