import { logger } from "../middleware/logger.js";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { issueQuestionResponseDeliveries, type Db } from "@paperclipai/db";
import { isRecoveryIssueTokenBudgetBlocked } from "./recovery/issue-token-budget.js";
import type { QuestionResponseDeliveryOutcome } from "./question-response-delivery.js";

type Issue = { companyId: string; id: string };
type BudgetCheck = (issue: Issue) => Promise<boolean>;

export function createQuestionResponseSweep(
  db: Db,
  deliver: (interactionId: string, checkBudget: BudgetCheck) => Promise<QuestionResponseDeliveryOutcome | null>,
  now: () => Date,
  claimStaleMs: number,
) {
  let cursor: string | undefined;
  let sweeping: Promise<{ scanned: number; steered: number; coalesced: number; wakeFallback: number; failed: number }> | undefined;
  async function sweepPage(limit: number) {
    const sweepAt = now();
    await db.update(issueQuestionResponseDeliveries).set({ status: "pending", updatedAt: sweepAt }).where(and(
      eq(issueQuestionResponseDeliveries.status, "delivering"),
      or(isNull(issueQuestionResponseDeliveries.lastAttemptAt),
        lte(issueQuestionResponseDeliveries.lastAttemptAt, new Date(sweepAt.getTime() - claimStaleMs))),
    ));
    const page = () => db.select({ interactionId: issueQuestionResponseDeliveries.interactionId })
      .from(issueQuestionResponseDeliveries).where(and(eq(issueQuestionResponseDeliveries.status, "pending"),
        or(isNull(issueQuestionResponseDeliveries.nextAttemptAt), lte(issueQuestionResponseDeliveries.nextAttemptAt, sweepAt)),
        cursor ? sql`(${issueQuestionResponseDeliveries.createdAt}, ${issueQuestionResponseDeliveries.interactionId}) >
          (select created_at, interaction_id from issue_question_response_deliveries where interaction_id = ${cursor})` : undefined,
      )).orderBy(asc(issueQuestionResponseDeliveries.createdAt), asc(issueQuestionResponseDeliveries.interactionId)).limit(limit);
    let rows = await page();
    if (!rows.length && cursor) { cursor = undefined; rows = await page(); }
    const budgets = new Map<string, Promise<boolean>>();
    const checkBudget: BudgetCheck = (issue) => {
      const key = `${issue.companyId}:${issue.id}`;
      if (!budgets.has(key)) budgets.set(key, isRecoveryIssueTokenBudgetBlocked(db, issue));
      return budgets.get(key)!;
    };
    const counts = { scanned: rows.length, steered: 0, coalesced: 0, wakeFallback: 0, failed: 0 };
    for (const row of rows) {
      // Advance past held rows. A later page wraps to retry older answers.
      cursor = row.interactionId;
      const outcome = await deliver(row.interactionId, checkBudget).catch((err) => {
        logger.warn({ err, interactionId: row.interactionId }, "question response delivery remains pending");
        return null;
      });
      if (outcome?.mode === "steered") counts.steered += 1;
      else if (outcome?.mode === "coalesced") counts.coalesced += 1;
      else if (outcome?.mode === "wake_fallback") counts.wakeFallback += 1;
      else if (outcome?.status === "failed") counts.failed += 1;
    }
    return counts;
  }
  return (limit = 50) => {
    if (!sweeping) sweeping = sweepPage(limit).finally(() => { sweeping = undefined; });
    return sweeping;
  };
}
