import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { and, eq, ne } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import type { NativeRestartRecoveryClaim } from "./native-runtime/native-restart-recovery.js";

type Recovery = { nativeLeaseOwner?: string; nativeRestartRecovery?: NativeRestartRecoveryClaim };
type Suppression = { suppressed: boolean; reason: string | null };

export function isRunnerReattachment(recovery?: NativeRestartRecoveryClaim) {
  return recovery?.kind === "reattach_existing_runner" || recovery?.kind === "reattach_remote_runner";
}

export async function suppressRunAdmission(db: Db, runId: string, recovery: Recovery, suppression: Suppression) {
  const reattachingRunner = isRunnerReattachment(recovery.nativeRestartRecovery);
  // Reattachment observes admitted work. The executor still verifies runner
  // ownership. A drain must not release that work's run or issue claim.
  if (suppression.suppressed && !(reattachingRunner && suppression.reason === "task_drain")) {
    if (!recovery.nativeLeaseOwner && !recovery.nativeRestartRecovery) {
      try {
        await releaseRunClaimedJustBeforeSuppression(db, runId);
      } catch (err) {
        logger.error(
          { err, runId },
          "failed to release run claimed just before task-drain suppression; the run row stays running, and the orphan reaper finalizes it and releases the issue lock on its next cycle",
        );
      }
    }
    return true;
  }

  return false;
}

// Admission can stop between claim and dispatch. Release all claim rows
// atomically. The tracked execution promise includes this transaction.
async function releaseRunClaimedJustBeforeSuppression(db: Db, runId: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const released = await tx
      .update(heartbeatRuns)
      .set({
        status: "queued",
        startedAt: null,
        responsibleUserId: null,
        updatedAt: now,
      })
      .where(
        and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!released) return;

    if (released.wakeupRequestId) {
      await tx
        .update(agentWakeupRequests)
        .set({ status: "queued", claimedAt: null, updatedAt: now })
        .where(and(eq(agentWakeupRequests.id, released.wakeupRequestId), ne(agentWakeupRequests.status, "cancelled")));
    }

    const value = released.contextSnapshot?.issueId;
    const issueId = typeof value === "string" && value.trim().length > 0 ? value : null;
    if (issueId) {
      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, issueId),
            eq(issues.companyId, released.companyId),
            eq(issues.executionRunId, released.id),
          ),
        );
    }
  });
}
