import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import type { SshInPlaceLockHolder } from "./ssh-in-place-lock.js";

/** Lease expiration alone never proves that a host writer stopped. */
export function sshInPlaceLockChecks(db: Db, companyId: string,
  confirmStopped?: (lease: EnvironmentLease) => Promise<EnvironmentLease | null>) {
  async function readLease(holder: SshInPlaceLockHolder) {
    const rows = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, holder.leaseId), eq(environmentLeases.companyId, companyId),
    )).limit(1);
    const lease = rows[0];
    return lease?.heartbeatRunId === holder.runId ? lease : undefined;
  }
  async function runIsTerminal(runId: string | null) {
    if (!runId) return false;
    const rows = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId),
    )).limit(1);
    return Boolean(rows[0] && ["succeeded", "failed", "cancelled", "timed_out"].includes(rows[0].status));
  }
  return {
    isHolderActive: async (holder: SshInPlaceLockHolder) => {
      const lease = await readLease(holder);
      return lease?.status === "active" && !(confirmStopped && await runIsTerminal(holder.runId));
    },
    isHolderStopped: async (holder: SshInPlaceLockHolder) => {
      const lease = await readLease(holder);
      if (!lease) return false;
      if (hasRemoteTerminationReceipt(lease)) return true;
      if (!confirmStopped || !await runIsTerminal(holder.runId)) return false;
      const stopped = await confirmStopped(lease as EnvironmentLease);
      return Boolean(stopped && hasRemoteTerminationReceipt(stopped));
    },
  };
}
