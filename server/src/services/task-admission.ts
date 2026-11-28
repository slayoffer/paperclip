import { randomUUID } from "node:crypto";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

export type TaskDrainState = { startedAt: Date; expiresAt: Date | null; ownerId?: string };
let taskDrainState: TaskDrainState | null = null;
const expiryListeners = new Set<() => void>();
const changeListeners = new Set<() => void>();
const drainClearedListeners = new Set<() => void>();
let lastClearedOwnedLeaseId: string | undefined;

function notifyDrainChanged() {
  for (const listener of changeListeners) listener();
}
export function subscribeTaskDrainChanges(listener: () => void) {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}
export function subscribeTaskDrainExpiry(listener: () => void) {
  expiryListeners.add(listener);
  return () => { expiryListeners.delete(listener); };
}
export function subscribeTaskDrainCleared(listener: () => void) {
  drainClearedListeners.add(listener);
  return () => { drainClearedListeners.delete(listener); };
}

export function notifyTaskDrainCleared(ownedLeaseId?: string): void {
  // A local release and the database observer can report the same lease.
  if (ownedLeaseId) {
    if (ownedLeaseId === lastClearedOwnedLeaseId) return;
    lastClearedOwnedLeaseId = ownedLeaseId;
  }
  for (const listener of drainClearedListeners) {
    try { listener(); } catch (error) { process.emitWarning(`Task drain cleared notification failed: ${String(error)}`); }
  }
}

// The coordinator owns local and persisted drain deadlines and their shutdown.
// A lease write rechecks the persisted deadline through the database wake signal.
// Empty state requires no recurring scans or timers.
type DurableTaskDrainLease = { leaseId?: string; expiresAt: string };
export function registerTaskDrainExpiryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  onExpired: () => void,
  readLeaseSnapshot?: () => Promise<DurableTaskDrainLease | null>,
) {
  let activeLease: DurableTaskDrainLease | null = null;
  let settledRelease: { leaseId: string } | null = null;
  let startupDrainRecheck: object | null = null;
  let unobservedClearReported = false;
  let lastHandledExpiryLeaseId: string | undefined;
  const worker = coordinator.register(DELIVERY_QUEUES.taskDrainExpiry, {
    retryMs: 1000,
    runDuringDrain: true,
    onSettled: hints => {
      const leaseId = hints?.values().next().value;
      if (leaseId) settledRelease = { leaseId };
    },
    run: async () => {
      readTaskDrain(new Date());
      if (!readLeaseSnapshot) return;
      const release = settledRelease;
      const recheck = startupDrainRecheck;
      const previousLease = activeLease;
      const lease = await readLeaseSnapshot();
      activeLease = lease && Date.parse(lease.expiresAt) > Date.now() ? lease : null;
      if (settledRelease === release) settledRelease = null;
      if (startupDrainRecheck === recheck) startupDrainRecheck = null;
      if (activeLease) {
        unobservedClearReported = false;
      } else {
        const clearedLeaseId = lease?.leaseId ?? release?.leaseId ?? previousLease?.leaseId;
        const startupDrainCleared = recheck !== null && readTaskDrain(new Date()) === null;
        const foundExpiredOnStartupRecheck = startupDrainCleared && Boolean(lease?.leaseId);
        if (previousLease || release || foundExpiredOnStartupRecheck) {
          notifyTaskDrainCleared(clearedLeaseId);
        } else if (startupDrainCleared && !unobservedClearReported) {
          // A different process may have released the lease before this worker read it.
          unobservedClearReported = true;
          notifyTaskDrainCleared();
        }
        if (previousLease || (foundExpiredOnStartupRecheck && clearedLeaseId !== lastHandledExpiryLeaseId)) {
          lastHandledExpiryLeaseId = clearedLeaseId;
          onExpired();
        }
      }
    },
    hasPending: async () => false,
    nextRunAt: () => {
      const localDeadline = taskDrainState?.expiresAt?.getTime();
      const durableDeadline = activeLease ? Date.parse(activeLease.expiresAt) : null;
      if (localDeadline === undefined) return durableDeadline;
      return durableDeadline === null ? localDeadline : Math.min(localDeadline, durableDeadline);
    },
  });
  expiryListeners.add(onExpired);
  changeListeners.add(worker.wake);
  return {
    ready: worker.ready,
    recheckStartupDrain() {
      startupDrainRecheck = {};
      worker.wake();
    },
    async stop() {
      changeListeners.delete(worker.wake);
      expiryListeners.delete(onExpired);
      await worker.stop();
    },
  };
}

// Set while this server cannot renew its controller instance lease: it stops
// dispatching new work until the lease is renewed (or it exits). It never
// replaces an operator's drain and has no idle owner, so HTTP stays open.
let controllerLeaseQuiesce: TaskDrainState | null = null;
export function isControllerLeaseQuiesced(): boolean {
  return controllerLeaseQuiesce !== null;
}
export function setControllerLeaseQuiesce(quiesced: boolean): void {
  if (quiesced === (controllerLeaseQuiesce !== null)) return;
  controllerLeaseQuiesce = quiesced ? { startedAt: new Date(), expiresAt: null } : null;
  notifyDrainChanged();
  if (!quiesced) notifyTaskDrainCleared();
}

export function readTaskDrain(now: Date): TaskDrainState | null {
  if (taskDrainState?.expiresAt && taskDrainState.expiresAt.getTime() <= now.getTime()) {
    taskDrainState = null;
    for (const listener of expiryListeners) {
      try { listener(); } catch (error) { process.emitWarning(`Task drain expiry notification failed: ${String(error)}`); }
    }
    notifyTaskDrainCleared();
  }
  return taskDrainState ?? controllerLeaseQuiesce;
}

export function computeTaskDrain(opts: { ttlMs?: number | null; purpose?: "idle" } = {}): TaskDrainState {
  const startedAt = new Date();
  return { startedAt, expiresAt: opts.ttlMs == null ? null : new Date(startedAt.getTime() + opts.ttlMs),
    ...(opts.purpose === "idle" ? { ownerId: randomUUID() } : {}) };
}

export function applyTaskDrain(drain: TaskDrainState): void {
  taskDrainState = drain;
  notifyDrainChanged();
}
export function startTaskDrain(opts: { ttlMs?: number | null; purpose?: "idle" } = {}): TaskDrainState {
  const drain = computeTaskDrain(opts);
  applyTaskDrain(drain);
  return drain;
}
export function stopTaskDrain(): { wasActive: boolean } {
  const wasActive = readTaskDrain(new Date()) !== null && taskDrainState !== null;
  taskDrainState = null;
  notifyDrainChanged();
  if (wasActive) notifyTaskDrainCleared();
  return { wasActive };
}
export function isIdleTaskDrainActive(): boolean { return Boolean(readTaskDrain(new Date())?.ownerId); }

// Tokens count work until its actual promise settles, including after HTTP
// disconnects and after a cleanup batch has been removed from its input queue.
// The generation also catches work which starts AND finishes during a scan.
let generation = 0;
let active = 0;
const settledListeners = new Set<() => void>();
/** Called (synchronously) whenever the last tracked work finishes. */
export function subscribeIdleWorkSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => { settledListeners.delete(listener); };
}
export function beginIdleTrackedWork(): () => void {
  generation++;
  active++;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    active--;
    generation++;
    if (active === 0) for (const listener of settledListeners) {
      try { listener(); } catch { /* a listener never blocks work accounting */ }
    }
  };
}
export function trackIdleWork<T>(work: Promise<T>): Promise<T> {
  const finish = beginIdleTrackedWork();
  return work.finally(finish);
}
export function idleWorkSnapshot() { return { generation, active }; }
