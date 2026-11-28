import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { createStartupHeartbeatRecovery } from "../startup-heartbeat-recovery.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerTaskDrainExpiryWork, subscribeTaskDrainCleared } from "../services/task-admission.js";

describe("startup recovery admission deadlines", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("leaves warm standby quiet before recovery is pending", async () => {
    const coordinator = makeCoordinator(() => false);
    const startup = createStartupHeartbeatRecovery({
      coordinator, canRun: () => false,
      checkSuppression: async () => ({ suppressed: false, reason: null }),
      recover: async () => ({ recovered: true, drainObserved: false }),
      recheckDrain: vi.fn(), track: vi.fn(),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(coordinator.nextWakeAt()).toBeNull();
    } finally {
      await startup.stop();
      await coordinator.stop();
    }
  });

  function makeCoordinator(canRun = () => true) {
    const owner = installDatabaseWorkSignals({ execute: async () => [], transaction: async () => {
      throw new Error("Startup recovery deadlines do not open transactions");
    } });
    return createDeliveryWorkCoordinator({ owner, canRun, onError: vi.fn() });
  }

  function startupFixture(input: Pick<Parameters<typeof createStartupHeartbeatRecovery>[0], "recover" | "checkSuppression">,
    readSnapshot = async () => null,
  ) {
    const coordinator = makeCoordinator();
    const attempts: Promise<void>[] = [];
    const startup = createStartupHeartbeatRecovery({
      ...input,
      coordinator,
      canRun: () => true,
      recheckDrain: pass => worker.recheckStartupDrain(pass),
      track: work => { attempts.push(work); },
    });
    const worker = registerTaskDrainExpiryWork(coordinator, vi.fn(), readSnapshot);
    const unsubscribe = subscribeTaskDrainCleared(startup.drainCleared);
    return {
      coordinator, startup, ready: worker.ready,
      async stop() {
        unsubscribe();
        await startup.stop();
        await worker.stop();
        await coordinator.stop();
        await Promise.all(attempts);
      },
    };
  }

  it("reports consecutive anonymous clears once per startup recheck", async () => {
    const coordinator = makeCoordinator();
    const worker = registerTaskDrainExpiryWork(coordinator, vi.fn(), async () => null);
    const cleared = vi.fn();
    const unsubscribe = subscribeTaskDrainCleared(cleared);
    try {
      await worker.ready;
      const firstPass = Symbol();
      worker.recheckStartupDrain(firstPass);
      await vi.advanceTimersByTimeAsync(1);
      expect(cleared).toHaveBeenCalledTimes(1);

      worker.recheckStartupDrain(firstPass);
      await vi.advanceTimersByTimeAsync(1);
      expect(cleared).toHaveBeenCalledTimes(1);

      worker.recheckStartupDrain(Symbol());
      await vi.advanceTimersByTimeAsync(1);
      expect(cleared).toHaveBeenCalledTimes(2);
      expect(coordinator.nextWakeAt()).toBeNull();
    } finally {
      unsubscribe();
      await worker.stop();
      await coordinator.stop();
    }
  });

  it("resumes after two unseen remote leases clear and completes only one pass", async () => {
    let held = false;
    const checkSuppression = vi.fn(async () => ({ suppressed: held, reason: held ? "task_drain" : null }));
    const complete = vi.fn();
    const recover = vi.fn(async () => {
      complete();
      return { recovered: true, drainObserved: false };
    }).mockImplementationOnce(async () => {
      // A second lease arrives after the first anonymous clear admits recovery.
      held = true;
      return { recovered: false, drainObserved: true };
    });
    const fixture = startupFixture({ checkSuppression, recover }, async () => {
      // Each lease is acquired and released before the next database read.
      held = false;
      return null;
    });
    const cleared = vi.fn();
    const unsubscribe = subscribeTaskDrainCleared(cleared);
    try {
      await fixture.ready;
      held = true;
      await fixture.startup.start();
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(cleared).toHaveBeenCalledTimes(2);
      expect(cleared.mock.calls[0]?.[0]).not.toBe(cleared.mock.calls[1]?.[0]);
      expect(recover).toHaveBeenCalledTimes(2);
      expect(complete).toHaveBeenCalledOnce();
      expect(fixture.coordinator.nextWakeAt()).toBeNull();
    } finally {
      unsubscribe();
      await fixture.stop();
    }
  });

  it("retries pending startup recovery at its deadline without another event", async () => {
    let held = true;
    const recover = vi.fn(async () => ({ recovered: true, drainObserved: false }));
    const fixture = startupFixture({ recover, checkSuppression: async () => ({
      suppressed: held, reason: held ? "database_restore_in_progress" : null,
    }) });
    try {
      await fixture.ready;
      await fixture.startup.start();
      held = false;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledOnce();
      expect(fixture.coordinator.nextWakeAt()).toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(recover).toHaveBeenCalledOnce();
    } finally {
      await fixture.stop();
    }
  });

  it("cancels an armed startup recovery retry on shutdown", async () => {
    const deadline = Date.now() + 5_000;
    const checkSuppression = vi.fn(async () => ({ suppressed: true, reason: "database_restore_in_progress" }));
    const recover = vi.fn(async () => ({ recovered: true, drainObserved: false }));
    const fixture = startupFixture({ checkSuppression, recover });
    try {
      await fixture.ready;
      await fixture.startup.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.coordinator.nextWakeAt()).toBe(deadline);
      await fixture.stop();
      expect(fixture.coordinator.nextWakeAt()).toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(checkSuppression).toHaveBeenCalledOnce();
      expect(recover).not.toHaveBeenCalled();
    } finally {
      await fixture.stop();
    }
  });
});
