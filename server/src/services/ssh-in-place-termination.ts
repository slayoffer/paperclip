import { realpath } from "node:fs/promises";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { runSshCommand } from "@paperclipai/adapter-utils/ssh";
import { sshWriterStopScript, sshWriterTerminationScript } from "@paperclipai/adapter-utils/ssh-writer-termination";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import { environmentService } from "./environments.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { isSshInPlaceOwnerRunTerminal } from "./ssh-in-place-run-status.js";
import { releaseConfirmedSshInPlaceWorktreeLock } from "./ssh-in-place-lock.js";
import { readSshInPlaceWriterTracking } from "./ssh-in-place-writer-tracking.js";

/** No SSH disconnect or terminal run status is sufficient by itself. */
export async function confirmSshInPlaceTermination(
  db: Db, environment: Environment, lease: EnvironmentLease,
  status: "released" | "expired" | "failed",
): Promise<EnvironmentLease | null> {
  const tracking = readSshInPlaceWriterTracking(lease);
  if (!tracking?.remoteCwd ||
      !lease.heartbeatRunId || lease.provider !== "ssh" || lease.environmentId !== environment.id) return null;
  try {
    const key = await realpath(tracking.key);
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, lease.companyId, environment, {
      issueId: lease.issueId, heartbeatRunId: lease.heartbeatRunId,
    });
    if (parsed.driver !== "ssh") return null;
    const config = parsed.config;
    // A changed environment endpoint cannot prove termination on the old host.
    if (lease.providerLeaseId !== `ssh://${config.username}@${config.host}:${config.port}${tracking.remoteCwd}` ||
        config.remoteWorkspacePath !== lease.metadata?.remoteWorkspacePath) return null;
    // Only terminal runs can prove that an absent directory means no writer started.
    const allowMissingDirectory = await isSshInPlaceOwnerRunTerminal(db, lease.companyId, lease.heartbeatRunId);
    const result = await runSshCommand(config,
      sshWriterTerminationScript(config.remoteWorkspacePath, lease.heartbeatRunId, { allowMissingDirectory }),
      { timeoutMs: 15_000 });
    if (result.stdout.trim() !== "stopped") return null;
    const receipt = remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" });
    if (!receipt) return null;
    const released = await environmentService(db).releaseLease(lease.id, status, {
      cleanupStatus: "success", remoteExecutionTermination: receipt,
    });
    if (released) releaseConfirmedSshInPlaceWorktreeLock(key, lease.id);
    return released;
  } catch {
    // A failed probe or database write preserves durable ownership.
    return null;
  }
}

/** An SSH lease can end (expired, failed, released) before its cleanup ran, so it never gets a termination receipt,
 * and a pause or termination that waits for stop proof of the cancelled run then never completes (Reviewer·Codex,
 * 2026-10-31: lease expired, cleanup null). Probe each such lease of the agents' cancelled runs once per call; the
 * probe writes the receipt only when the remote writer is confirmed stopped. Cancels before historyBefore need none. */
export async function confirmClosedSshLeaseStops(db: Db, agentIds: string[], historyBefore?: Date | null) {
  if (!agentIds.length) return 0;
  const rows = await db.select({ lease: environmentLeases, environment: environments }).from(environmentLeases)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId),
      eq(heartbeatRuns.companyId, environmentLeases.companyId)))
    .innerJoin(environments, eq(environments.id, environmentLeases.environmentId))
    .where(and(inArray(heartbeatRuns.agentId, agentIds), eq(heartbeatRuns.status, "cancelled"),
      eq(environmentLeases.provider, "ssh"), inArray(environmentLeases.status, ["expired", "failed", "released"]),
      sql`${environmentLeases.metadata}->'remoteExecutionTermination' is null`,
      historyBefore ? gte(heartbeatRuns.finishedAt, historyBefore) : undefined));
  let confirmed = 0;
  for (const { lease, environment } of rows) {
    const status = lease.status as "expired" | "failed" | "released";
    if (await confirmSshInPlaceTermination(db, environment as Environment, lease as EnvironmentLease, status)) confirmed++;
  }
  return confirmed;
}

/** SYNA-2959: before a server restart, stop the run's tracked SSH writers and prove that they stopped. A killed SSH
 * client proves nothing about the remote provider, so without this a restart can never resume an SSH run
 * (restart_remote_stop_unverified). Returns true only on the "stopped" receipt. The lease stays held. */
export async function stopSshInPlaceWritersForRestart(
  db: Db, run: { id: string; companyId: string }, graceSec = 20,
): Promise<boolean> {
  try {
    const [row] = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
      eq(environmentLeases.provider, "ssh"), eq(environmentLeases.status, "active"), isNull(environmentLeases.releasedAt),
    )).limit(1);
    if (!row) return false;
    const lease = row as unknown as EnvironmentLease;
    const tracking = readSshInPlaceWriterTracking(lease);
    if (!tracking?.remoteCwd || !lease.environmentId) return false;
    const environment = await environmentService(db).getById(lease.environmentId);
    if (!environment) return false;
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, lease.companyId, environment, {
      issueId: lease.issueId, heartbeatRunId: run.id,
    });
    if (parsed.driver !== "ssh") return false;
    const config = parsed.config;
    // A changed environment endpoint cannot stop or prove anything on the old host.
    if (lease.providerLeaseId !== `ssh://${config.username}@${config.host}:${config.port}${tracking.remoteCwd}` ||
        config.remoteWorkspacePath !== lease.metadata?.remoteWorkspacePath) return false;
    await runSshCommand(config, sshWriterStopScript(config.remoteWorkspacePath, run.id, graceSec),
      { timeoutMs: (graceSec + 15) * 1000 });
    const result = await runSshCommand(config, sshWriterTerminationScript(config.remoteWorkspacePath, run.id),
      { timeoutMs: 15_000 });
    return result.stdout.trim() === "stopped";
  } catch {
    return false;
  }
}
