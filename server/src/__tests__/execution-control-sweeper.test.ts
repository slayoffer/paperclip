import { expect, it, vi } from "vitest";
import { createExecutionControlSweeper } from "../services/execution-control-sweeper.js";

it("starts each queue once and keeps slow ownership probes independent", async () => {
  let resolve!: () => void;
  const slow = vi.fn(() => new Promise<void>(r => { resolve = r; }));
  const fast = vi.fn();
  const tracked: Promise<unknown>[] = [];
  let stopped = false;
  const sweep = createExecutionControlSweeper({ stopped: () => stopped,
    queues: [["ssh", slow], ["other", fast]], track: work => { tracked.push(work); }, onError: vi.fn() });
  sweep(); sweep(); await Promise.resolve();
  expect(slow).toHaveBeenCalledTimes(1); expect(fast).toHaveBeenCalledTimes(1);
  await tracked[1]; sweep(); await Promise.resolve();
  expect(fast).toHaveBeenCalledTimes(2); expect(slow).toHaveBeenCalledTimes(1);
  stopped = true; sweep(); resolve(); await Promise.all(tracked);
  expect(fast).toHaveBeenCalledTimes(2);
  stopped = false; sweep(); await Promise.resolve(); resolve(); await Promise.all(tracked);
  expect(slow).toHaveBeenCalledTimes(2);
});

it("permits retry after a failed queue and reports its name", async () => {
  const failure = new Error("unavailable");
  const work = vi.fn().mockRejectedValue(failure);
  const onError = vi.fn(); const tracked: Promise<unknown>[] = [];
  const sweep = createExecutionControlSweeper({ stopped: () => false, queues: [["ssh", work]],
    track: promise => { tracked.push(promise); }, onError });
  sweep(); await Promise.all(tracked); sweep(); await Promise.all(tracked);
  expect(onError).toHaveBeenCalledWith(failure, "ssh"); expect(work).toHaveBeenCalledTimes(2);
});
