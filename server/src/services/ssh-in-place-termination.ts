import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { runSshCommand } from "@paperclipai/adapter-utils/ssh";
import { sshWriterTerminationScript } from "@paperclipai/adapter-utils/ssh-writer-termination";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import { environmentService } from "./environments.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { releaseConfirmedSshInPlaceWorktreeLock } from "./ssh-in-place-lock.js";

/** No SSH disconnect or terminal run status is sufficient by itself. */
export async function confirmSshInPlaceTermination(
  db: Db, environment: Environment, lease: EnvironmentLease,
  status: "released" | "expired" | "failed",
): Promise<EnvironmentLease | null> {
  const tracking = lease.metadata?.sshInPlaceWriter as { key?: unknown; remoteCwd?: unknown } | undefined;
  if (!tracking || typeof tracking.key !== "string" || typeof tracking.remoteCwd !== "string" ||
      !lease.heartbeatRunId || lease.provider !== "ssh" || lease.environmentId !== environment.id) return null;
  try {
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, lease.companyId, environment, {
      issueId: lease.issueId, heartbeatRunId: lease.heartbeatRunId,
    });
    if (parsed.driver !== "ssh") return null;
    const config = parsed.config;
    // A changed environment endpoint cannot prove termination on the old host.
    if (lease.providerLeaseId !== `ssh://${config.username}@${config.host}:${config.port}${tracking.remoteCwd}` ||
        config.remoteWorkspacePath !== lease.metadata?.remoteWorkspacePath) return null;
    const result = await runSshCommand(config,
      sshWriterTerminationScript(config.remoteWorkspacePath, lease.heartbeatRunId), { timeoutMs: 15_000 });
    if (result.stdout.trim() !== "stopped") return null;
    const receipt = remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" });
    if (!receipt) return null;
    const released = await environmentService(db).releaseLease(lease.id, status, {
      cleanupStatus: "success", remoteExecutionTermination: receipt,
    });
    if (released) releaseConfirmedSshInPlaceWorktreeLock(tracking.key, lease.id);
    return released;
  } catch {
    // A failed probe or database write preserves durable ownership.
    return null;
  }
}
