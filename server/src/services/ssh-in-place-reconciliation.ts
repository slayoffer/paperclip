import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { environmentLeases, environments, executionWorkspaces, heartbeatRuns, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { canonicalSshInPlaceLockKey } from "./ssh-in-place-workspace.js";
import { readSshInPlaceWorktreeLockHolder, releaseConfirmedSshInPlaceWorktreeLock } from "./ssh-in-place-lock.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { confirmSshInPlaceTermination } from "./ssh-in-place-termination.js";
import { SSH_IN_PLACE_TERMINAL_RUN_STATUSES } from "./ssh-in-place-run-status.js";
import { logger } from "../middleware/logger.js";

const batchSize = 20;

/** Each invocation advances a bounded page. Busy and uncertain older rows must
 * not starve later locks. The scheduler supplies startup and single-flight. */
export function createSshInPlaceOwnershipReconciler(db: Db) {
  let cursor: string | undefined;
  return async () => {
    const rows = await db.select({ lease: environmentLeases, environment: environments, cwd: executionWorkspaces.cwd })
      .from(environmentLeases)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId),
        eq(heartbeatRuns.companyId, environmentLeases.companyId)))
      .innerJoin(environments, eq(environments.id, environmentLeases.environmentId))
      .leftJoin(executionWorkspaces, and(eq(executionWorkspaces.id, environmentLeases.executionWorkspaceId),
        eq(executionWorkspaces.companyId, environmentLeases.companyId)))
      .where(and(eq(environmentLeases.provider, "ssh"), eq(environments.driver, "ssh"),
        inArray(heartbeatRuns.status, SSH_IN_PLACE_TERMINAL_RUN_STATUSES), cursor ? gt(environmentLeases.id, cursor) : undefined))
      .orderBy(asc(environmentLeases.id)).limit(batchSize);
    let released = 0;
    for (const row of rows) {
      try {
        const lease = row.lease as EnvironmentLease;
        const tracking = lease.metadata?.sshInPlaceWriter as { key?: unknown; remoteCwd?: unknown } | undefined;
        const cwd = typeof tracking?.key === "string" ? tracking.key : row.cwd;
        if (!cwd || !lease.heartbeatRunId) continue;
        const key = await canonicalSshInPlaceLockKey(cwd);
        const holder = readSshInPlaceWorktreeLockHolder(key);
        if (holder?.leaseId !== lease.id || holder.runId !== lease.heartbeatRunId) continue;
        if (hasRemoteTerminationReceipt(lease)) {
          if (releaseConfirmedSshInPlaceWorktreeLock(key, lease.id)) released++;
          continue;
        }
        const remoteCwd = typeof tracking?.remoteCwd === "string" ? tracking.remoteCwd : lease.metadata?.remoteCwd;
        if (typeof remoteCwd !== "string") continue;
        const candidate = { ...lease, metadata: { ...lease.metadata, sshInPlaceWriter: { key, remoteCwd } } };
        const status = lease.status === "expired" || lease.status === "failed" ? lease.status : "released";
        const stopped = await confirmSshInPlaceTermination(db, row.environment as Environment, candidate, status);
        if (stopped && !readSshInPlaceWorktreeLockHolder(key)) released++;
      } catch {
        // Corrupt files, missing paths, failed probes, and failed writes retain ownership.
      }
    }
    cursor = rows.length === batchSize ? rows.at(-1)!.lease.id : undefined;
    if (released) logger.info({ scanned: rows.length, released }, "Reconciled stopped SSH worktree owners");
    return { scanned: rows.length, released };
  };
}
