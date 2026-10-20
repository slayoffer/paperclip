import type { issueThreadInteractions } from "@paperclipai/db";
import type { AskUserQuestionsInteraction } from "@paperclipai/shared";
import { buildQuestionResponseDeliveryEnvelope } from "./question-response-delivery-envelope.js";
import { nativeSha256 } from "./native-runtime/canonical.js";

type QuestionInteractionRow = typeof issueThreadInteractions.$inferSelect;
const DELIVERY_CORRELATION_PREFIX = "question-response:";

export function hydrateQuestionInteraction(
  row: QuestionInteractionRow,
): AskUserQuestionsInteraction {
  return {
    ...row,
    kind: "ask_user_questions",
    status: row.status as AskUserQuestionsInteraction["status"],
    continuationPolicy:
      row.continuationPolicy as AskUserQuestionsInteraction["continuationPolicy"],
    resolverPolicy: row.effectiveResolverPolicy,
    requestedResolverPolicy: row.requestedResolverPolicy,
    effectiveResolverPolicy: row.effectiveResolverPolicy,
    resolverPolicyProvenance: row.resolverPolicyProvenance,
    effectiveResolverPolicySource: row.effectiveResolverPolicySource,
    legacyResolverPolicyAliases: { requested: null, effective: null },
    payload: row.payload as AskUserQuestionsInteraction["payload"],
    result: row.result as AskUserQuestionsInteraction["result"],
  };
}

export function questionResponseDeliveryValues(
  interaction: AskUserQuestionsInteraction,
) {
  const envelope = buildQuestionResponseDeliveryEnvelope(interaction);
  return {
    companyId: interaction.companyId,
    issueId: interaction.issueId,
    interactionId: interaction.id,
    sourceRunId: interaction.sourceRunId ?? null,
    correlationId: `${DELIVERY_CORRELATION_PREFIX}${interaction.id}`,
    payloadSha256: nativeSha256(envelope),
  };
}
