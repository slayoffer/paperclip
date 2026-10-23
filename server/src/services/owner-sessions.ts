import path from "node:path";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";

export function ownerSessionsEnabled(agent: { id: string; adapterType: string }, env = process.env): boolean {
  if (env.PAPERCLIP_OWNER_SESSIONS_ENABLED !== "true") return false;
  if (!["codex_local", "claude_local"].includes(agent.adapterType)) return false;
  const selected = env.PAPERCLIP_OWNER_SESSION_AGENT_IDS?.split(",").map(id => id.trim()).filter(Boolean);
  return !selected?.length || selected.includes(agent.id);
}

export function resolveOwnerSession(input: {
  agent: { id: string; companyId: string; adapterType: string };
  projectId: string | null;
  agentHome: string;
  eligible: boolean;
}) {
  if (!input.eligible || !input.projectId || !ownerSessionsEnabled(input.agent)) return null;
  return {
    key: `owner-project:${input.projectId}`,
    projectId: input.projectId,
    localDirectory: path.join(input.agentHome, "owner-sessions", input.projectId),
  };
}

// An owner thread spans many issues. The task-session wake resets (issue_assigned, review recovery, approval
// requested, unscoped timer) exist to give each ISSUE a clean start; applied to an owner thread they would start a
// fresh thread on every new issue, which is the cost this mode removes. Only an explicit request resets it.
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
