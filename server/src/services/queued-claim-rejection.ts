import { HttpError } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import { INTAKE_SKIP_REASON } from "./issue-intake-check.js";
import { logger } from "../middleware/logger.js";

// Identity denials cannot clear on retry. Intake refusals require a fresh pickup
// after the description changes. Settle both after releasing the agent start lock.
export function isPermanentClaimRejection(err: unknown): err is HttpError {
  return err instanceof HttpError && (err.status === 403 || parseObject(err.details).code === INTAKE_SKIP_REASON);
}

// Other 4xx rejections can clear later (a responsible user gets assigned, a
// conflicting claim finishes). Keep the run queued, but do not let it stop
// the rest of the queue or startup recovery.
export function isDeferrableClaimRejection(err: unknown): err is HttpError {
  return err instanceof HttpError && err.status >= 400 && err.status < 500;
}

// Settle after the agent start lock ends. Cancellation can promote another run.
export async function cancelRejectedQueuedRuns(
  rejected: Array<{ run: { id: string; agentId: string; companyId: string }; err: HttpError }>,
  cancelRun: (runId: string, reason: string, options: {
    errorCode: string; suppressImmediateRecovery: boolean;
  }) => Promise<unknown>,
) {
  for (const { run, err } of rejected) {
    logger.warn({ err, runId: run.id, agentId: run.agentId, companyId: run.companyId },
      "cancelling queued heartbeat run whose claim was rejected");
    try {
      await cancelRun(run.id, `Cancelled because the queued run cannot be claimed: ${err.message}`, {
        errorCode: "queued_run_claim_rejected",
        suppressImmediateRecovery: parseObject(err.details).code === INTAKE_SKIP_REASON,
      });
    } catch (cancelErr) {
      logger.error({ err: cancelErr, runId: run.id },
        "failed to cancel queued heartbeat run whose claim was rejected; it stays queued for the next recovery pass");
    }
  }
}
