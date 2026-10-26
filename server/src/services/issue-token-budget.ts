import { and, desc, eq, gte, like, ne, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Per-issue input-token budget (synthiq fork, Guild model v2 rule 5, 2026-10-17). With PAPERCLIP_ISSUE_TOKEN_BUDGET=N,
 * a wake on an issue whose runs used N or more weighted input tokens in the current window is skipped
 * (`issue.token_budget_exceeded`), and one confirmation card is raised on the issue. An explicit budget override bypasses
 * this gate. The window starts at PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE (go-live; a rolling 24 hours when unset), or at the
 * latest accepted budget card on the issue: accepting the card grants a fresh window. The card is addressed to
 * PAPERCLIP_ISSUE_TOKEN_BUDGET_CARD_AGENT_ID when set, otherwise to the board.
 */
export interface IssueTokenBudgetConfig {
  budget: number;
  cachedWeight: number;
  since: Date | null;
  cardAgentId: string | null;
}

export const ISSUE_TOKEN_BUDGET_CARD_KEY_PREFIX = "issue-token-budget:";
export const ISSUE_TOKEN_BUDGET_SKIP_REASON = "issue.token_budget_exceeded";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CACHED_WEIGHT = 0.1;
let warnedInvalidCachedWeight = false;

export function issueTokenBudgetConfig(env: NodeJS.ProcessEnv = process.env): IssueTokenBudgetConfig | null {
  const raw = env.PAPERCLIP_ISSUE_TOKEN_BUDGET?.trim();
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1) return null;
  const weightRaw = env.PAPERCLIP_ISSUE_TOKEN_BUDGET_CACHED_WEIGHT?.trim();
  const parsedWeight = weightRaw ? Number(weightRaw) : NaN;
  const validWeight = Number.isFinite(parsedWeight) && parsedWeight >= 0 && parsedWeight <= 1;
  const cachedWeight = validWeight ? parsedWeight : DEFAULT_CACHED_WEIGHT;
  if (weightRaw !== undefined && !validWeight && !warnedInvalidCachedWeight) {
    warnedInvalidCachedWeight = true;
    logger.warn("Invalid PAPERCLIP_ISSUE_TOKEN_BUDGET_CACHED_WEIGHT. Use a number from 0 to 1. Using 0.1.");
  }
  const sinceRaw = env.PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE?.trim();
  const since = sinceRaw && Number.isFinite(Date.parse(sinceRaw)) ? new Date(sinceRaw) : null;
  const agent = env.PAPERCLIP_ISSUE_TOKEN_BUDGET_CARD_AGENT_ID?.trim();
  return { budget: Number(raw), cachedWeight, since, cardAgentId: agent && UUID_RE.test(agent) ? agent : null };
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
  const validInput = sql`${heartbeatRuns.usageJson}->>'inputTokens' ~ '^[0-9]+$'`;
  const inputTokens = sql`case when ${validInput}
    then (${heartbeatRuns.usageJson}->>'inputTokens')::numeric else 0 end`;
  const cachedTokens = sql`case when ${validInput} and ${heartbeatRuns.usageJson}->>'cachedInputTokens' ~ '^[0-9]+$'
    then (${heartbeatRuns.usageJson}->>'cachedInputTokens')::numeric else 0 end`;
  const spent = Number((await db
    .select({ n: sql<string>`coalesce(sum(greatest(${inputTokens} - ${cachedTokens}, 0)
      + ${cachedTokens} * ${config.cachedWeight}), 0)::text` })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      gte(heartbeatRuns.createdAt, windowStart),
    )))[0]?.n ?? 0);
  return { spent, windowStart, exceeded: spent >= config.budget };
}

export function issueTokenBudgetSkipDetails(
  config: IssueTokenBudgetConfig,
  state: IssueTokenBudgetState,
  payload: Record<string, unknown>,
) {
  return {
    error: `Wake suppressed: this issue used ${state.spent} weighted input tokens since ` +
      `${state.windowStart.toISOString()} (budget ${config.budget}). Cached tokens count at ${config.cachedWeight}.`,
    payload: { ...payload, issueTokenBudget: {
      used: state.spent, limit: config.budget, cachedWeight: config.cachedWeight,
      windowStart: state.windowStart.toISOString(),
    } },
  };
}

const millions = (n: number) => `${(n / 1_000_000).toFixed(1)}M`;

/** Raise one budget card per issue and window. Returns true when a new card was created. */
export async function ensureIssueTokenBudgetCard(
  db: Db,
  input: { companyId: string; issueId: string; config: IssueTokenBudgetConfig; state: IssueTokenBudgetState },
): Promise<boolean> {
  // Recovery and heartbeat admission share this lock. Rolling-window starts
  // can differ between callers, so the exact idempotency key is insufficient.
  return db.transaction(async (tx) => {
    const [issue] = await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
      .for("update");
    if (!issue) return false;
    const client = tx as unknown as Db;
    const state = await loadIssueTokenBudgetState(client, input);
    if (!state.exceeded) return false;
    const [stop] = await tx.select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        like(issueThreadInteractions.idempotencyKey, `${ISSUE_TOKEN_BUDGET_CARD_KEY_PREFIX}%`),
        ne(issueThreadInteractions.status, "accepted"),
        or(
          eq(issueThreadInteractions.idempotencyKey, `${ISSUE_TOKEN_BUDGET_CARD_KEY_PREFIX}${state.windowStart.toISOString()}`),
          gte(issueThreadInteractions.createdAt, state.windowStart),
        ),
      )).limit(1);
    if (stop) return false;
    return insertIssueTokenBudgetCard(client, { ...input, state });
  });
}

async function insertIssueTokenBudgetCard(
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
      summary: `Runs on this issue used ${millions(state.spent)} weighted input tokens since ${state.windowStart.toISOString()} ` +
        `(budget ${millions(config.budget)}). Cached tokens count at ${config.cachedWeight}. Agent wakes on this issue are stopped.`,
      addresseeAgentId: config.cardAgentId,
      payload: {
        version: 1,
        prompt: `This issue used ${millions(state.spent)} weighted input tokens (budget ${millions(config.budget)}). ` +
          `Cached tokens count at ${config.cachedWeight}. ` +
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
