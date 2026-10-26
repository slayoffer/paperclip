import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { blockerIsResolved } from "./blocked-state-integrity.js";
import type { recoveryService } from "./recovery/service.js";
import { logger } from "../middleware/logger.js";

/** Finalization repeats readiness after the completion route's workspace barrier. */
export async function wakeDependentsAfterFinalization(db: Db, recovery: ReturnType<typeof recoveryService>,
  run: { id: string; companyId: string }, issueId: string,
) {
  try {
    const [issue] = await db.select({ status: issues.status }).from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)));
    if (issue && blockerIsResolved(issue.status)) {
      await recovery.reconcileResolvedDependencyWakeBackstop({ runId: run.id, companyId: run.companyId,
        blockerIssueId: issueId, source: "workspace.finalize" });
    }
  } catch (err) {
    logger.warn({ err, runId: run.id, issueId }, "failed to evaluate dependent wakes after workspace_finalize");
  }
}
