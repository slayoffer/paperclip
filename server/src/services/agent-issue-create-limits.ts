import { and, eq, gte, ne, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";

/**
 * Agent issue-creation limits (synthiq fork, Guild model v2 rule 1, 2026-10-17). Each limit is an operator switch,
 * off unless its env var is a positive integer:
 * - PAPERCLIP_AGENT_CHILDREN_PER_PARENT: child issues one agent may create under one parent (cancelled ones not counted).
 * - PAPERCLIP_AGENT_ISSUES_PER_DAY: issues one agent may create in a rolling 24 hours.
 * - PAPERCLIP_AGENT_ISSUE_MAX_DEPTH: deepest level an agent may create at; a top-level issue is depth 1.
 * Board actors are not limited. The route refuses with 409 and a message that names the limit and the way out.
 */
export interface AgentIssueCreateLimits {
  childrenPerParent: number | null;
  issuesPerDay: number | null;
  maxDepth: number | null;
}

const positiveInt = (raw: string | undefined) => {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 ? n : null;
};

export function agentIssueCreateLimits(env: NodeJS.ProcessEnv = process.env): AgentIssueCreateLimits {
  return {
    childrenPerParent: positiveInt(env.PAPERCLIP_AGENT_CHILDREN_PER_PARENT),
    issuesPerDay: positiveInt(env.PAPERCLIP_AGENT_ISSUES_PER_DAY),
    maxDepth: positiveInt(env.PAPERCLIP_AGENT_ISSUE_MAX_DEPTH),
  };
}

export interface AgentIssueCreateCounts {
  childrenByAgentUnderParent: number;
  createdByAgentLast24h: number;
  /** Depth the new issue would have: 1 without a parent. */
  newIssueDepth: number;
}

/** Pure decision: the refusal message, or null when the create is allowed. */
export function agentIssueCreateRefusal(
  limits: AgentIssueCreateLimits,
  counts: AgentIssueCreateCounts,
  parentLabel: string | null,
  requested = 1,
): string | null {
  const asking = requested === 1 ? "" : ` and this request asks for ${requested} more`;
  if (limits.issuesPerDay !== null && counts.createdByAgentLast24h + requested > limits.issuesPerDay) {
    return `Issue limit reached: you created ${counts.createdByAgentLast24h} issues in the last 24 hours${asking} (limit ${limits.issuesPerDay}). ` +
      "Finish or merge existing work first, or ask the board to create this issue.";
  }
  if (parentLabel !== null && limits.childrenPerParent !== null &&
    counts.childrenByAgentUnderParent + requested > limits.childrenPerParent) {
    return `Child issue limit reached: you already created ${counts.childrenByAgentUnderParent} child issues under ${parentLabel}${asking} ` +
      `(limit ${limits.childrenPerParent} per parent). Put the plan in the parent's \`plan\` document and do the work in one issue, ` +
      "or ask the board to create this issue.";
  }
  if (limits.maxDepth !== null && counts.newIssueDepth > limits.maxDepth) {
    return `Issue depth limit reached: a new issue under ${parentLabel ?? "this parent"} would be at depth ${counts.newIssueDepth} ` +
      `(limit ${limits.maxDepth} below a goal). Create it next to its parent, or put the steps in the parent's \`plan\` document.`;
  }
  return null;
}

const ANCESTOR_SCAN_LIMIT = 32;

export async function loadAgentIssueCreateCounts(
  db: Db,
  input: { companyId: string; agentId: string; parentId: string | null; limits: AgentIssueCreateLimits; now?: Date },
): Promise<AgentIssueCreateCounts> {
  const { companyId, agentId, parentId, limits } = input;
  const since = new Date((input.now ?? new Date()).getTime() - 24 * 60 * 60 * 1000);
  const createdByAgentLast24h = limits.issuesPerDay === null ? 0 : Number((await db
    .select({ n: sql<number>`count(*)::int` })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.createdByAgentId, agentId), gte(issues.createdAt, since))))[0]?.n ?? 0);
  const childrenByAgentUnderParent = !parentId || limits.childrenPerParent === null ? 0 : Number((await db
    .select({ n: sql<number>`count(*)::int` })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.parentId, parentId), eq(issues.createdByAgentId, agentId),
      ne(issues.status, "cancelled"))))[0]?.n ?? 0);
  let newIssueDepth = 1;
  if (parentId && limits.maxDepth !== null) {
    const rows = await db.execute(sql`
      with recursive chain(id, parent_id, depth) as (
        select id, parent_id, 1 from issues where id = ${parentId} and company_id = ${companyId}
        union all
        select parent.id, parent.parent_id, chain.depth + 1 from issues parent join chain on parent.id = chain.parent_id
        where parent.company_id = ${companyId} and chain.depth < ${ANCESTOR_SCAN_LIMIT}
      )
      select coalesce(max(depth), 0)::int as depth from chain`);
    const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as Array<{ depth: number }>;
    newIssueDepth = Number(list[0]?.depth ?? 0) + 1;
  }
  return { childrenByAgentUnderParent, createdByAgentLast24h, newIssueDepth };
}
