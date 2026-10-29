import path from "node:path";
import type { EnvironmentLease } from "@paperclipai/shared";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Older agent-home leases have no execution workspace or separate writer tracking.
 * The saved realization identifies the path. It does not prove writer termination. */
export function readSshInPlaceWriterTracking(lease: EnvironmentLease, workspaceCwd?: string | null) {
  const tracking = record(lease.metadata?.sshInPlaceWriter);
  let key = typeof tracking.key === "string" ? tracking.key : workspaceCwd;
  if (!key) {
    const realization = record(lease.metadata?.workspaceRealization);
    const local = record(realization.local);
    if (realization.version !== 1 || realization.mode !== "in_place" || realization.provider !== "ssh" ||
        realization.leaseId !== lease.id || realization.environmentId !== lease.environmentId ||
        realization.providerLeaseId !== lease.providerLeaseId ||
        typeof local.path !== "string" || local.path !== realization.authoritativeRoot) return null;
    key = local.path;
  }
  const remoteCwd = typeof tracking.remoteCwd === "string" ? tracking.remoteCwd : lease.metadata?.remoteCwd;
  if (!key || !path.isAbsolute(key)) return null;
  return { key, remoteCwd: typeof remoteCwd === "string" && path.posix.isAbsolute(remoteCwd) ? remoteCwd : null };
}
