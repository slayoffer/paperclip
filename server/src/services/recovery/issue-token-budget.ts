import { and, eq, gte, like, ne, or } from "drizzle-orm";
import { issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import {
  ensureIssueTokenBudgetCard,
  ISSUE_TOKEN_BUDGET_CARD_KEY_PREFIX,
  issueTokenBudgetConfig,
  loadIssueTokenBudgetState,
} from "../issue-token-budget.js";

/** Check before recovery reserves an action, retry slot, or wake. */
export async function isRecoveryIssueTokenBudgetBlocked(
  db: Db,
  issue: { companyId: string; id: string },
): Promise<boolean> {
  const config = issueTokenBudgetConfig();
  if (!config) return false;
  const input = { companyId: issue.companyId, issueId: issue.id, config };
  const state = await loadIssueTokenBudgetState(db, input);
  if (!state.exceeded) return false;

  // The card is the durable stop record. Reuse it after rejection as well.
  // Rolling windows move on each sweep, so their exact keys cannot deduplicate
  // an unchanged stop. An accepted card instead starts a fresh budget window.
  const findStop = (client: Pick<Db, "select">, windowStart: Date) => client.select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, issue.companyId),
      eq(issueThreadInteractions.issueId, issue.id),
      like(issueThreadInteractions.idempotencyKey, `${ISSUE_TOKEN_BUDGET_CARD_KEY_PREFIX}%`),
      ne(issueThreadInteractions.status, "accepted"),
      or(
        eq(issueThreadInteractions.idempotencyKey, `${ISSUE_TOKEN_BUDGET_CARD_KEY_PREFIX}${windowStart.toISOString()}`),
        gte(issueThreadInteractions.createdAt, windowStart),
      ),
    ))
    .limit(1);
  const [stop] = await findStop(db, state.windowStart);
  if (stop) return true;

  // Concurrent recovery checks can observe different rolling-window starts.
  // Serialize first creation on the source issue, then recheck the grant.
  return db.transaction(async (tx) => {
    const [source] = await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, issue.id)))
      .for("update");
    if (!source) return true;
    const client = tx as unknown as Db;
    const current = await loadIssueTokenBudgetState(client, input);
    if (!current.exceeded) return false;
    const [existing] = await findStop(tx, current.windowStart);
    if (!existing) await ensureIssueTokenBudgetCard(client, { ...input, state: current });
    return true;
  });
}
