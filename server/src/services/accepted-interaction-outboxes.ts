import { and, eq, isNull } from "drizzle-orm";
import { interactionResolutionOutbox, issueQuestionResponseDeliveries, type Db } from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { ISSUE_TOKEN_BUDGET_CARD_KEY_PREFIX } from "./issue-token-budget.js";
import { logger } from "../middleware/logger.js";

type Delivery = { deliver: (interactionId: string) => Promise<unknown> };

/** Retry after the accepted budget card commits. Existing delivery fences prevent duplicate admission. */
export async function deliverAcceptedInteractionOutboxes(
  db: Db,
  interaction: IssueThreadInteraction,
  resolutions: Delivery,
  questions: Delivery,
  deliverCurrent = true,
) {
  const budgetGrant = interaction.status === "accepted" &&
    interaction.idempotencyKey?.startsWith(ISSUE_TOKEN_BUDGET_CARD_KEY_PREFIX);
  const attempt = async (service: Delivery, interactionId: string) => {
    try { await service.deliver(interactionId); }
    catch (err) {
      logger.warn({ err, interactionId, issueId: interaction.issueId }, "interaction continuation delivery remains pending");
    }
  };
  if (deliverCurrent) {
    if (budgetGrant) await attempt(resolutions, interaction.id);
    else await resolutions.deliver(interaction.id);
    if (interaction.kind === "ask_user_questions") await questions.deliver(interaction.id);
  }
  if (!budgetGrant) return;
  try {
    const [pendingQuestions, pendingResolutions] = await Promise.all([
      db.select({ id: issueQuestionResponseDeliveries.interactionId }).from(issueQuestionResponseDeliveries).where(and(
        eq(issueQuestionResponseDeliveries.companyId, interaction.companyId),
        eq(issueQuestionResponseDeliveries.issueId, interaction.issueId),
        eq(issueQuestionResponseDeliveries.status, "pending"),
      )),
      db.select({ id: interactionResolutionOutbox.interactionId }).from(interactionResolutionOutbox).where(and(
        eq(interactionResolutionOutbox.companyId, interaction.companyId),
        eq(interactionResolutionOutbox.issueId, interaction.issueId),
        isNull(interactionResolutionOutbox.deliveredAt),
      )),
    ]);
    for (const row of pendingQuestions) await attempt(questions, row.id);
    for (const row of pendingResolutions) {
      if (!deliverCurrent || row.id !== interaction.id) await attempt(resolutions, row.id);
    }
  } catch (err) {
    logger.warn({ err, issueId: interaction.issueId }, "accepted budget outbox scan will retry during a sweep");
  }
}
