import type { createDeliveryWorkCoordinator } from "./services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./services/delivery-work-notifications.js";

const INITIAL_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

export function createStartupHeartbeatRecovery(input: {
  coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">;
  canRun: () => boolean;
  checkSuppression: () => Promise<{ suppressed: boolean; reason: string | null }>;
  recover: () => Promise<{ recovered: boolean; drainObserved: boolean }>;
  recheckDrain: (pass: symbol) => void;
  track: (work: Promise<void>) => void;
}) {
  let pending = false;
  let running = false;
  let stopped = false;
  let wakePending: symbol | null = null;
  let retryAt: number | null = null;
  let retryDelayMs = INITIAL_RETRY_MS;
  let retryWorker: ReturnType<typeof input.coordinator.register> | undefined;

  const canRecover = () => pending && !stopped && input.canRun();

  function setRetryAt(deadline: number | null) {
    if (retryAt === deadline) return;
    retryAt = deadline;
    if (retryWorker) {
      retryWorker.wake();
    } else if (deadline !== null) {
      retryWorker = input.coordinator.register(DELIVERY_QUEUES.startupHeartbeatRecovery, {
        retryMs: INITIAL_RETRY_MS,
        runDuringDrain: true,
        run: async signal => {
          if (signal?.aborted || retryAt === null || retryAt > Date.now()) return;
          retryAt = null;
          if (canRecover() && !running) input.track(run(Symbol()));
        },
        hasPending: async () => false,
        nextRunAt: () => retryAt,
      });
    }
  }

  async function run(pass: symbol) {
    if (!canRecover() || running) return;
    running = true;
    setRetryAt(null);
    try {
      do {
        pass = wakePending ?? pass;
        wakePending = null;
        const suppression = await input.checkSuppression();
        if (!canRecover()) return;
        if (suppression.suppressed) {
          if (suppression.reason === "task_drain") input.recheckDrain(pass);
          continue;
        }
        // A clear received during the admission check is covered by this pass.
        wakePending = null;
        pass = Symbol();
        const result = await input.recover();
        if (!canRecover()) return;
        const afterRecovery = await input.checkSuppression();
        if (!canRecover()) return;
        if (result.drainObserved || afterRecovery.reason === "task_drain") input.recheckDrain(pass);
        if (result.recovered && !afterRecovery.suppressed && wakePending === null) pending = false;
      } while (wakePending !== null);
    } finally {
      running = false;
      if (canRecover()) {
        setRetryAt(Date.now() + retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_MS);
      }
    }
  }

  return {
    start() {
      if (!stopped) pending = true;
      return run(Symbol());
    },
    drainCleared(pass = Symbol()) {
      if (!canRecover()) return;
      if (running) {
        wakePending = pass;
        return;
      }
      input.track(run(pass));
    },
    async stop() {
      stopped = true;
      pending = false;
      wakePending = null;
      retryAt = null;
      await retryWorker?.stop();
    },
  };
}
