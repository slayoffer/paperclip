import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { environmentLeases, environments, executionWorkspaces, heartbeatRuns, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { canonicalSshInPlaceLockKey } from "./ssh-in-place-workspace.js";
import { readSshInPlaceWorktreeLockHolder, releaseConfirmedSshInPlaceWorktreeLock } from "./ssh-in-place-lock.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { confirmSshInPlaceTermination } from "./ssh-in-place-termination.js";
import { EXECUTION_RECONCILIATION_INTERVAL_MS } from "./execution-control-deadline.js";
import { logger } from "../middleware/logger.js";

const terminalStatuses = ["succeeded", "failed", "cancelled", "timed_out"];
const batchSize = 20;

/** Each invocation advances a bounded page. Busy and uncertain older rows must
 * not starve later locks. The scheduler supplies startup and single-flight. */
export function createSshInPlaceOwnershipReconciler(db: Db) {
  let cursor: string | undefined;
  let unresolved = false;
  let rescan = true;
  const reconcile = async () => {
    if (!cursor) { unresolved = false; rescan = false; }
    const rows = await db.select({ lease: environmentLeases, environment: environments, cwd: executionWorkspaces.cwd })
      .from(environmentLeases)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId),
        eq(heartbeatRuns.companyId, environmentLeases.companyId)))
      .innerJoin(environments, eq(environments.id, environmentLeases.environmentId))
      .leftJoin(executionWorkspaces, and(eq(executionWorkspaces.id, environmentLeases.executionWorkspaceId),
        eq(executionWorkspaces.companyId, environmentLeases.companyId)))
      .where(and(eq(environmentLeases.provider, "ssh"), eq(environments.driver, "ssh"),
        inArray(heartbeatRuns.status, terminalStatuses), cursor ? gt(environmentLeases.id, cursor) : undefined))
      .orderBy(asc(environmentLeases.id)).limit(batchSize);
    let released = 0;
    for (const row of rows) {
      let pending = false;
      try {
        const lease = row.lease as EnvironmentLease;
        const tracking = lease.metadata?.sshInPlaceWriter as { key?: unknown; remoteCwd?: unknown } | undefined;
        const cwd = typeof tracking?.key === "string" ? tracking.key : row.cwd;
        if (!cwd || !lease.heartbeatRunId) continue;
        pending = true;
        // Saved keys are canonical. A removed legacy workspace can still have
        // a sibling lock file; inspect it before deciding there is no work.
        const key = typeof tracking?.key === "string" ? tracking.key
          : await canonicalSshInPlaceLockKey(cwd).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return cwd;
            throw error;
          });
        const holder = readSshInPlaceWorktreeLockHolder(key);
        if (holder?.leaseId !== lease.id || holder.runId !== lease.heartbeatRunId) { pending = false; continue; }
        if (hasRemoteTerminationReceipt(lease)) {
          if (releaseConfirmedSshInPlaceWorktreeLock(key, lease.id)) { released++; pending = false; }
          continue;
        }
        const remoteCwd = typeof tracking?.remoteCwd === "string" ? tracking.remoteCwd : lease.metadata?.remoteCwd;
        if (typeof remoteCwd !== "string") continue;
        const candidate = { ...lease, metadata: { ...lease.metadata, sshInPlaceWriter: { key, remoteCwd } } };
        const status = lease.status === "expired" || lease.status === "failed" ? lease.status : "released";
        const stopped = await confirmSshInPlaceTermination(db, row.environment as Environment, candidate, status);
        if (stopped && !readSshInPlaceWorktreeLockHolder(key)) { released++; pending = false; }
      } catch {
        // Corrupt files, missing paths, failed probes, and failed writes retain ownership.
      } finally {
        unresolved ||= pending;
      }
    }
    cursor = rows.length === batchSize ? rows.at(-1)!.lease.id : undefined;
    if (released) logger.info({ scanned: rows.length, released }, "Reconciled stopped SSH worktree owners");
    return { scanned: rows.length, released };
  };
  return Object.assign(reconcile, {
    // A terminal write can affect an earlier page, including during a sweep.
    requestScan: () => { rescan = true; },
    nextRunAt: async () => cursor || unresolved || rescan
      ? Date.now() + EXECUTION_RECONCILIATION_INTERVAL_MS : null,
  });
}
