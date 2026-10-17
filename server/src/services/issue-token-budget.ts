import { and, desc, eq, gte, like, sql } from "drizzle-orm";
import { heartbeatRuns, issueThreadInteractions, type Db } from "@paperclipai/db";

/**
 * Per-issue input-token budget (synthiq fork, Guild model v2 rule 5, 2026-10-17). With PAPERCLIP_ISSUE_TOKEN_BUDGET=N,
 * a wake on an issue whose runs used N or more input tokens in the current window is skipped
 * (`issue.token_budget_exceeded`), and one confirmation card is raised on the issue. A wake requested by a person is not
 * limited. The window starts at PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE (go-live; a rolling 24 hours when unset), or at the
 * latest accepted budget card on the issue: accepting the card grants a fresh window. The card is addressed to
 * PAPERCLIP_ISSUE_TOKEN_BUDGET_CARD_AGENT_ID when set, otherwise to the board.
 */
export interface IssueTokenBudgetConfig {
  budget: number;
  since: Date | null;
  cardAgentId: string | null;
}

export const ISSUE_TOKEN_BUDGET_CARD_KEY_PREFIX = "issue-token-budget:";
export const ISSUE_TOKEN_BUDGET_SKIP_REASON = "issue.token_budget_exceeded";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function issueTokenBudgetConfig(env: NodeJS.ProcessEnv = process.env): IssueTokenBudgetConfig | null {
  const raw = env.PAPERCLIP_ISSUE_TOKEN_BUDGET?.trim();
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1) return null;
  const sinceRaw = env.PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE?.trim();
  const since = sinceRaw && Number.isFinite(Date.parse(sinceRaw)) ? new Date(sinceRaw) : null;
  const agent = env.PAPERCLIP_ISSUE_TOKEN_BUDGET_CARD_AGENT_ID?.trim();
  return { budget: Number(raw), since, cardAgentId: agent && UUID_RE.test(agent) ? agent : null };
}

export function issueTokenBudgetWindowStart(config: IssueTokenBudgetConfig, grantedAt: Date | null, now: Date): Date {
  const base = config.since ?? new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return grantedAt && grantedAt > base ? grantedAt : base;
}

export interface IssueTokenBudgetState {
  spent: number;
  windowStart: Date;
  exceeded: boolean;
}

export async function loadIssueTokenBudgetState(
  db: Db,
  input: { companyId: string; issueId: string; config: IssueTokenBudgetConfig; now?: Date },
): Promise<IssueTokenBudgetState> {
  const { companyId, issueId, config } = input;
  const now = input.now ?? new Date();
  const grant = (await db
    .select({ resolvedAt: issueThreadInteractions.resolvedAt })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.issueId, issueId),
      eq(issueThreadInteractions.status, "accepted"),
      like(issueThreadInteractions.idempotencyKey, `${ISSUE_TOKEN_BUDGET_CARD_KEY_PREFIX}%`),
    ))
    .orderBy(desc(issueThreadInteractions.resolvedAt))
    .limit(1))[0];
  const windowStart = issueTokenBudgetWindowStart(config, grant?.resolvedAt ?? null, now);
  const spent = Number((await db
    .select({ n: sql<string>`coalesce(sum(case when ${heartbeatRuns.usageJson}->>'inputTokens' ~ '^[0-9]+$'
      then (${heartbeatRuns.usageJson}->>'inputTokens')::bigint else 0 end), 0)::text` })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      gte(heartbeatRuns.createdAt, windowStart),
    )))[0]?.n ?? 0);
  return { spent, windowStart, exceeded: spent >= config.budget };
}

const millions = (n: number) => `${(n / 1_000_000).toFixed(1)}M`;

/** Raise one budget card per issue and window. Returns true when a new card was created. */
export async function ensureIssueTokenBudgetCard(
  db: Db,
  input: { companyId: string; issueId: string; config: IssueTokenBudgetConfig; state: IssueTokenBudgetState },
): Promise<boolean> {
  const { companyId, issueId, config, state } = input;
  const rows = await db
    .insert(issueThreadInteractions)
    .values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      idempotencyKey: `${ISSUE_TOKEN_BUDGET_CARD_KEY_PREFIX}${state.windowStart.toISOString()}`,
      title: "Issue token budget reached",
      summary: `Runs on this issue used ${millions(state.spent)} input tokens since ${state.windowStart.toISOString()} ` +
        `(budget ${millions(config.budget)}). Agent wakes on this issue are stopped.`,
      addresseeAgentId: config.cardAgentId,
      payload: {
        version: 1,
        prompt: `This issue used ${millions(state.spent)} input tokens (budget ${millions(config.budget)}). ` +
          "Accept to give it a new budget and wake the assignee. Reject to keep agent wakes stopped; then split, re-scope or cancel the issue.",
        acceptLabel: "Grant a new budget",
        rejectLabel: "Keep stopped",
        rejectRequiresReason: false,
        allowDeclineReason: true,
        supersedeOnUserComment: false,
      },
    })
    .onConflictDoNothing()
    .returning({ id: issueThreadInteractions.id });
  return rows.length > 0;
}
