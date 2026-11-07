import path from "node:path";
import { agentTaskSessions, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { and, desc, eq, or, sql } from "drizzle-orm";

const OWNER_SESSION_KEY_PREFIX = "owner-project:";

/** The controller owns `owner-project:*` rows. A task key from a wake must never address one. */
export function isOwnerSessionKey(value: unknown): boolean {
  return typeof value === "string" && value.trim().startsWith(OWNER_SESSION_KEY_PREFIX);
}

/** The first caller-supplied task key that does not address a reserved owner row. */
export function firstCallerTaskKey(candidates: Array<string | null>): string | null {
  return candidates.find((key): key is string => key !== null && !isOwnerSessionKey(key)) ?? null;
}

export function ownerSessionsEnabled(agent: { id: string; adapterType: string }, env = process.env): boolean {
  if (env.PAPERCLIP_OWNER_SESSIONS_ENABLED !== "true") return false;
  if (!["codex_local", "claude_local"].includes(agent.adapterType)) return false;
  const selected = env.PAPERCLIP_OWNER_SESSION_AGENT_IDS?.split(",").map(id => id.trim()).filter(Boolean);
  return !selected?.length || selected.includes(agent.id);
}

/** Scope comes only from the current company-scoped issue row, never from wake context. */
export function resolveOwnerSession(input: {
  agent: { id: string; companyId: string; adapterType: string };
  issue: { projectId: string | null } | null;
  agentHome: string;
  eligible: boolean;
}) {
  const projectId = input.issue?.projectId ?? null;
  if (!input.eligible || !projectId || !ownerSessionsEnabled(input.agent)) return null;
  return {
    key: `${OWNER_SESSION_KEY_PREFIX}${projectId}`,
    projectId,
    localDirectory: path.join(input.agentHome, "owner-sessions", projectId),
  };
}

// An owner thread spans many issues. The task-session wake resets (issue_assigned, review recovery, approval
// requested, unscoped timer) exist to give each ISSUE a clean start; applied to an owner thread they would start a
// fresh thread on every new issue, which is the cost this mode removes. Only an explicit request resets it.
/**
 * An issue-scoped session reset must also clear the owner thread that serves the issue. Resolve its key from the
 * company's issue row (UUID or identifier) with the same rules as resolveOwnerSession.
 */
export async function ownerSessionKeyForIssueReset(
  db: Db,
  input: { agent: { id: string; companyId: string; adapterType: string }; taskKey: string },
): Promise<string | null> {
  const taskKey = input.taskKey.trim();
  if (!taskKey || isOwnerSessionKey(taskKey) || !ownerSessionsEnabled(input.agent)) return null;
  const [issue] = await db.select({ projectId: issues.projectId }).from(issues)
    .where(and(eq(issues.companyId, input.agent.companyId),
      or(sql`${issues.id}::text = ${taskKey}`, eq(issues.identifier, taskKey.toUpperCase()))))
    .limit(1);
  return resolveOwnerSession({ agent: input.agent, issue: issue ?? null, agentHome: "/", eligible: true })?.key ?? null;
}

export function shouldResetOwnerSessionForWake(context: Record<string, unknown> | null | undefined): boolean {
  return context?.forceFreshSession === true;
}

export function describeOwnerSessionResetReason(context: Record<string, unknown> | null | undefined): string | null {
  return shouldResetOwnerSessionForWake(context) ? "forceFreshSession was requested" : null;
}

export function ownerSessionInputLimit(env = process.env): number | null {
  const limit = Number(env.PAPERCLIP_OWNER_SESSION_MAX_INPUT_TOKENS);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
}

export function ownerSessionEngineEligible(base: Record<string, unknown>, overrides?: Record<string, unknown> | null): boolean {
  const engine = overrides?.engine ?? base.engine;
  return typeof engine === "string" && engine.trim().toLowerCase() === "cli";
}

export async function readOwnerSessionInputTokens(db: Db, companyId: string, agentId: string, sessionId: string): Promise<number> {
  const rows = await db.select({ total: sql<string>`coalesce(sum(case
    when jsonb_typeof(${heartbeatRuns.usageJson}->'inputTokens') = 'number'
    then (${heartbeatRuns.usageJson}->>'inputTokens')::numeric else 0 end), 0)` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.sessionIdAfter, sessionId)));
  return Number(rows[0]?.total ?? 0);
}

const OWNER_USAGE_SAMPLE_SCAN = 50;

/**
 * Owner Codex turns report thread-cumulative totals. A turn that fails before `turn.completed` reports no usage
 * but keeps the thread id. Subtract the newest earlier run that has a valid sample, not the newest run.
 */
export async function readLatestUsageSample<T>(
  db: Db,
  input: { agentId: string; sessionId: string; excludeRunId: string },
  read: (usageJson: unknown) => T | null,
): Promise<T | null> {
  const rows = await db.select({ usageJson: heartbeatRuns.usageJson }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.sessionIdAfter, input.sessionId),
      sql`${heartbeatRuns.id} <> ${input.excludeRunId}`))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(OWNER_USAGE_SAMPLE_SCAN);
  for (const row of rows) {
    const sample = read(row.usageJson);
    if (sample) return sample;
  }
  return null;
}

/**
 * Save the shared owner row while the run still holds the agent's only admission slot, so a successor never reads
 * stale state. A finalizer is stale, and writes nothing, when its run has left `running` or when the row moved to
 * another run after this run read it.
 */
export async function saveOwnerSessionState(db: Db, input: {
  companyId: string;
  agentId: string;
  adapterType: string;
  key: string;
  runId: string;
  expectedLastRunId: string | null;
  /** `null` clears the row. */
  session: { params: Record<string, unknown> | null; displayId: string | null } | null;
  lastError: string | null;
}): Promise<"saved" | "cleared" | "stale"> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId))).for("update");
    if (run?.status !== "running") return "stale";
    const scope = and(eq(agentTaskSessions.companyId, input.companyId), eq(agentTaskSessions.agentId, input.agentId),
      eq(agentTaskSessions.adapterType, input.adapterType), eq(agentTaskSessions.taskKey, input.key));
    const [row] = await tx.select({ id: agentTaskSessions.id, lastRunId: agentTaskSessions.lastRunId })
      .from(agentTaskSessions).where(scope).for("update");
    const current = row ? row.lastRunId : null;
    if (row ? current !== input.expectedLastRunId && current !== input.runId : input.expectedLastRunId !== null) {
      return "stale";
    }
    if (!input.session) {
      if (row) await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.id, row.id));
      return "cleared";
    }
    const values = {
      sessionParamsJson: input.session.params,
      sessionDisplayId: input.session.displayId,
      lastRunId: input.runId,
      lastError: input.lastError,
    };
    if (row) {
      await tx.update(agentTaskSessions).set({ ...values, updatedAt: new Date() }).where(eq(agentTaskSessions.id, row.id));
      return "saved";
    }
    const inserted = await tx.insert(agentTaskSessions).values({
      companyId: input.companyId, agentId: input.agentId, adapterType: input.adapterType, taskKey: input.key, ...values,
    }).onConflictDoNothing().returning({ id: agentTaskSessions.id });
    return inserted.length > 0 ? "saved" : "stale";
  });
}
