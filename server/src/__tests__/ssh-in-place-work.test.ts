import { afterEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { notifyExecutionRunWork } from "../services/execution-control-notifications.js";
import { registerExecutionControlWork } from "../services/execution-control-work.js";

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
afterEach(async () => {
  for (const worker of coordinators.splice(0)) await worker.stop();
  vi.useRealTimers();
});
function coordinator(owner: object) {
  const worker = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError: error => { throw error; } });
  coordinators.push(worker);
  return worker;
}
function fakeOwner() {
  const execute = vi.fn(async () => [{ xid: "42" }]);
  const owner = installDatabaseWorkSignals({ execute, async transaction(fn: (tx: any) => Promise<any>): Promise<any> {
    return fn({ execute, transaction: owner.transaction });
  } });
  return owner;
}
describe("SSH ownership work", () => {
  it("scans SSH ownership at startup, wakes on terminal writes, and retries only pending work", async () => {
    vi.useFakeTimers();
    const owner = fakeOwner(); const c = coordinator(owner);
    let pending = false;
    const run = vi.fn(async () => {});
    const onSettled = vi.fn();
    await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionSshOwnership,
      run, onSettled, next: async () => pending ? Date.now() + 15_000 : null }]).ready;
    expect(run).toHaveBeenCalledTimes(1); expect(c.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    pending = true;
    await owner.transaction(tx => notifyExecutionRunWork(tx));
    await vi.advanceTimersByTimeAsync(1);
    expect(onSettled).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(run).toHaveBeenCalledTimes(3);
    pending = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(run).toHaveBeenCalledTimes(4); expect(c.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(4);
  });
});
