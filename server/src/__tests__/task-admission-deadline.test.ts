import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyTaskDrainCleared, registerTaskDrainExpiryWork, readTaskDrain, startTaskDrain, stopTaskDrain, subscribeTaskDrainCleared } from "../services/task-admission.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";

describe("task drain deadline", () => {
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  let worker: ReturnType<typeof registerTaskDrainExpiryWork>;
  let resume = vi.fn<() => void>();
  const execute = vi.fn(async () => []);
  const transaction = async () => { throw new Error("No transaction is expected for a process-local deadline"); };
  beforeEach(async () => {
    vi.useFakeTimers();
    resume = vi.fn<() => void>();
    execute.mockClear();
    coordinator = createDeliveryWorkCoordinator({ owner: installDatabaseWorkSignals({ execute, transaction }), canRun: () => false,
      canReconcile: () => true, onError: error => { throw error; } });
    worker = registerTaskDrainExpiryWork(coordinator, resume);
    await worker.ready;
  });
  afterEach(async () => {
    await worker.stop(); await coordinator.stop(); stopTaskDrain(); vi.useRealTimers();
  });

  it("releases admission once at its deadline without a status read or periodic sweep", async () => {
    startTaskDrain({ ttlMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.nextWakeAt()).toBe(Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(readTaskDrain(new Date())).toBeNull();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["replace", "stop", "shutdown"] as const)("does not resume from an obsolete expiry after %s", async action => {
    startTaskDrain({ ttlMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    if (action === "replace") startTaskDrain({ ttlMs: null });
    if (action === "stop") stopTaskDrain();
    if (action === "shutdown") {
      await worker.stop();
      await coordinator.stop();
      expect(vi.getTimerCount()).toBe(0);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores a stored expiry deadline once and makes no recurring idle reads", async () => {
    await worker.stop();
    await coordinator.stop();
    const expiresAt = Date.now() + 1000;
    const readLease = vi.fn(async () => Date.now() < expiresAt
      ? { expiresAt: new Date(expiresAt).toISOString() }
      : null);
    coordinator = createDeliveryWorkCoordinator({ owner: installDatabaseWorkSignals({ execute, transaction }), canRun: () => true, onError: vi.fn() });
    worker = registerTaskDrainExpiryWork(coordinator, resume, readLease);
    await worker.ready;
    expect(coordinator.nextWakeAt()).toBe(expiresAt);
    await vi.advanceTimersByTimeAsync(999);
    expect(resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resume).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(readLease).toHaveBeenCalledTimes(2);
    expect(coordinator.nextWakeAt()).toBeNull();
  });

  it("uses the explicit release hint when the observed lease is stale", async () => {
    await worker.stop();
    await coordinator.stop();
    const readTransactionId = async () => [{ xid: "42" }];
    const owner = installDatabaseWorkSignals({ execute: readTransactionId,
      async transaction<T>(operation: (tx: { execute: typeof readTransactionId; transaction: typeof transaction }) => Promise<T>) {
        return operation({ execute: readTransactionId, transaction });
      },
    });
    const leaseA = { leaseId: "observed-task-drain-lease", expiresAt: new Date(Date.now() + 1000).toISOString() };
    let lease: typeof leaseA | null = leaseA;
    const cleared = vi.fn();
    const unsubscribe = subscribeTaskDrainCleared(cleared);
    coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError: vi.fn() });
    worker = registerTaskDrainExpiryWork(coordinator, resume, async () => lease);
    try {
      await worker.ready;
      notifyTaskDrainCleared(leaseA.leaseId);
      expect(cleared).toHaveBeenCalledOnce();

      lease = null;
      await owner.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.taskDrainExpiry, "unobserved-released-lease"));
      await vi.advanceTimersByTimeAsync(0);
      expect(cleared).toHaveBeenCalledTimes(2);

      await owner.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.taskDrainExpiry));
      await vi.advanceTimersByTimeAsync(0);
      expect(cleared).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("removes its listener on close and rearms an existing drain on a new lifecycle", async () => {
    startTaskDrain({ ttlMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await worker.stop();
    expect(coordinator.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(readTaskDrain(new Date())).toBeNull();
    expect(resume).not.toHaveBeenCalled();
    startTaskDrain({ ttlMs: 1000 });
    const next = createDeliveryWorkCoordinator({ owner: installDatabaseWorkSignals({ execute, transaction }), canRun: () => true, onError: vi.fn() });
    const resumed = vi.fn();
    const nextWorker = registerTaskDrainExpiryWork(next, resumed);
    try {
      await nextWorker.ready;
      await vi.advanceTimersByTimeAsync(1000);
      expect(resumed).toHaveBeenCalledOnce();
      expect(resume).not.toHaveBeenCalled();
    } finally { await nextWorker.stop(); await next.stop(); }
  });
});
