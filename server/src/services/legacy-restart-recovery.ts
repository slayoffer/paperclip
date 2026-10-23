import fs from "node:fs/promises";
import { isAbsolute } from "node:path";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { legacyControllerBootId, legacyControllerClaim } from "./legacy-controller-lease.js";

type Run = typeof heartbeatRuns.$inferSelect;
export type LegacyRestartCheckpoint = {
  version: 1;
  adapterType: string;
  companyId: string;
  agentId: string;
  issueId: string;
  taskKey: string | null;
  aiSessionIdentity?: string | null;
  providerSessionHome?: string;
  executionWorkspaceId: string | null;
  workspaceCwd: string;
  providerStopped?: boolean;
  workspaceSettled?: boolean;
  sessionParams: Record<string, unknown> & { sessionId: string; cwd: string };
};

export function preserveLegacyRestartEvidence(
  previous: Record<string, unknown> | null | undefined,
  result: Record<string, unknown>,
) {
  return {
    ...(previous?.restartCheckpoint ? { restartCheckpoint: previous.restartCheckpoint } : {}),
    ...(previous?.restartRecovery ? { restartRecovery: previous.restartRecovery } : {}),
    ...result,
    // A reaper snapshot can predate its own persisted fallback decision.
    ...((previous?.restartRecovery as Record<string, unknown> | undefined)?.outcome === "reconciliation"
      ? { restartRecovery: previous!.restartRecovery } : {}),
  };
}

export function readLegacyRestartCheckpoint(run: Run): LegacyRestartCheckpoint | null {
  const value = run.resultJson?.restartCheckpoint as LegacyRestartCheckpoint | undefined;
  if (!value || value.version !== 1 || value.companyId !== run.companyId || value.agentId !== run.agentId ||
      value.issueId !== run.contextSnapshot?.issueId || value.executionWorkspaceId !== (run.contextSnapshot?.executionWorkspaceId ?? null) ||
      !["codex_local", "claude_local"].includes(value.adapterType) ||
      typeof value.workspaceCwd !== "string" || !value.workspaceCwd.startsWith("/") ||
      typeof value.sessionParams?.cwd !== "string" || !value.sessionParams.cwd.startsWith("/") ||
      (value.providerSessionHome !== undefined && (typeof value.providerSessionHome !== "string" || !isAbsolute(value.providerSessionHome))) ||
      typeof value.sessionParams?.sessionId !== "string" || !value.sessionParams.sessionId) return null;
  return value;
}

/** These parameters come from the adapter, not wake payloads or task text. */
export async function saveLegacyRestartCheckpoint(db: Db, run: Run, input: {
  adapterType: string;
  taskKey: string | null;
  aiSessionIdentity?: string | null;
  providerSessionHome?: string;
  workspaceCwd: string;
  sessionParams: Record<string, unknown>;
}) {
  if (run.runtimeMode !== "legacy" || !["codex_local", "claude_local"].includes(input.adapterType) ||
      typeof run.contextSnapshot?.issueId !== "string" ||
      typeof input.sessionParams.sessionId !== "string" || typeof input.sessionParams.cwd !== "string") return;
  const checkpoint = { version: 1, companyId: run.companyId, agentId: run.agentId,
    issueId: run.contextSnapshot.issueId, executionWorkspaceId: run.contextSnapshot?.executionWorkspaceId ?? null, ...input };
  await db.update(heartbeatRuns).set({
    sessionIdAfter: input.sessionParams.sessionId,
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ restartCheckpoint: checkpoint })}::jsonb`,
  }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.controllerBootId, legacyControllerBootId)));
}

export async function recordLegacyRestartFallback(db: Db, run: Run, reason: string) {
  await db.update(heartbeatRuns).set({
    resultJson: sql`jsonb_set(coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb), '{restartRecovery}', coalesce(${heartbeatRuns.resultJson}->'restartRecovery', '{}'::jsonb) || ${JSON.stringify({ outcome: "reconciliation", reason })}::jsonb)`,
  }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    run.controllerBootId ? eq(heartbeatRuns.controllerBootId, run.controllerBootId) : isNull(heartbeatRuns.controllerBootId)));
}

export async function saveLegacyRestartProviderHome(db: Db, run: Run, home: string) {
  await db.update(heartbeatRuns).set({
    resultJson: sql`jsonb_set(${heartbeatRuns.resultJson}, '{restartCheckpoint,providerSessionHome}', ${JSON.stringify(home)}::jsonb)`,
  }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
    sql`${heartbeatRuns.resultJson}->'restartCheckpoint' is not null`));
}

export async function markLegacyRestartBoundary(db: Db, run: Run, boundary: "providerStopped" | "workspaceSettled") {
  await db.update(heartbeatRuns).set({
    resultJson: sql`jsonb_set(${heartbeatRuns.resultJson}, array['restartCheckpoint', ${boundary}]::text[], 'true'::jsonb)`,
  }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.controllerBootId, legacyControllerBootId), eq(heartbeatRuns.status, "running"),
    sql`${heartbeatRuns.resultJson}->'restartCheckpoint' is not null`));
}

/** The caller first proves that no provider PID or process group is alive.
 * A lease expiry alone never permits overlapping provider work. */
export async function claimLegacyRestartRecovery(db: Db, run: Run, adapterType: string) {
  const checkpoint = readLegacyRestartCheckpoint(run);
  let reason: string | null = !checkpoint ? "restart_session_missing" : null;
  if (checkpoint && checkpoint.adapterType !== adapterType) reason = "restart_adapter_changed";
  const remote = checkpoint?.sessionParams.remoteExecution as Record<string, unknown> | undefined;
  if (remote && remote.transport !== "ssh") reason = "restart_sandbox_session_unsupported";
  // An SSH wrapper PID cannot prove that its remote provider stopped.
  if (checkpoint?.sessionParams.remoteExecution &&
      (!checkpoint.providerStopped || !checkpoint.workspaceSettled) && !reason) reason = "restart_remote_stop_unverified";
  const attempts = Number((run.resultJson?.restartRecovery as Record<string, unknown>)?.attempt ?? 0);
  if (attempts >= 3) reason = "restart_attempt_limit";
  if (checkpoint && !reason) {
    const directories = checkpoint.sessionParams.remoteExecution
      ? [checkpoint.workspaceCwd] : [checkpoint.workspaceCwd, checkpoint.sessionParams.cwd];
    for (const directory of directories) {
      if (!(await fs.stat(directory).catch(() => null))?.isDirectory()) reason = "restart_workspace_missing";
    }
    if (checkpoint.providerSessionHome &&
        (!isAbsolute(checkpoint.providerSessionHome) ||
          !(await fs.stat(checkpoint.providerSessionHome).catch(() => null))?.isDirectory())) reason = "restart_provider_state_missing";
  }
  if (reason || !checkpoint) {
    await recordLegacyRestartFallback(db, run, reason ?? "restart_session_missing");
    return null;
  }
  // Lock the issue first, matching checkout and terminalization lock order.
  return db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, checkpoint.issueId),
      eq(issues.companyId, run.companyId))).for("update");
    if (!issue || issue.assigneeAgentId !== run.agentId || issue.executionRunId !== run.id ||
        ["done", "cancelled"].includes(issue.status)) return null;
    const [claimed] = await tx.update(heartbeatRuns).set({
      ...legacyControllerClaim("legacy"), processPid: null, processGroupId: null, processStartedAt: null,
      error: null, errorCode: null,
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
        restartCheckpoint: { ...checkpoint, providerStopped: false, workspaceSettled: false },
        restartRecovery: { outcome: "resuming", attempt: attempts + 1, sessionId: checkpoint.sessionParams.sessionId },
      })}::jsonb`,
    }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
      run.controllerBootId ? eq(heartbeatRuns.controllerBootId, run.controllerBootId) : isNull(heartbeatRuns.controllerBootId),
      run.processPid ? eq(heartbeatRuns.processPid, run.processPid) : isNull(heartbeatRuns.processPid),
      run.processGroupId ? eq(heartbeatRuns.processGroupId, run.processGroupId) : isNull(heartbeatRuns.processGroupId),
      or(isNull(heartbeatRuns.controllerLeaseExpiresAt), lte(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`)),
    )).returning();
    return claimed ? checkpoint : null;
  });
}
