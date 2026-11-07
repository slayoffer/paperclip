import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import type { recoveryService } from "./recovery/service.js";
import { logger } from "../middleware/logger.js";

/** Finalization repeats readiness after the completion route's workspace barrier. */
export async function wakeDependentsAfterFinalization(db: Db,
  recovery: Pick<ReturnType<typeof recoveryService>, "reconcileResolvedDependencyWakeBackstop">,
  run: { id: string; companyId: string }, issueId: string,
) {
  try {
    const [issue] = await db.select({ status: issues.status }).from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)));
    if (issue?.status === "done" || issue?.status === "cancelled") {
      await recovery.reconcileResolvedDependencyWakeBackstop({ runId: run.id, companyId: run.companyId,
        blockerIssueId: issueId, source: "workspace.finalize" });
    }
  } catch (err) {
    logger.warn({ err, runId: run.id, issueId }, "failed to evaluate dependent wakes after workspace_finalize");
  }
}
