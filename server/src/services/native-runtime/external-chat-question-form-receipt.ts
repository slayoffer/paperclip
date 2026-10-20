import type { chatActions } from "@paperclipai/db";
import type { AskUserQuestionsInteraction } from "@paperclipai/shared";
import { parseChatQuestionFormSubmitTokenPayload, validateChatQuestionFormSubmission } from "../chat-question-forms.js";
import { nativeSha256 } from "./canonical.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];

export function completedQuestionFormMatchesInteraction(
  interaction: AskUserQuestionsInteraction,
  action: typeof chatActions.$inferSelect,
): boolean {
  const payload = parseChatQuestionFormSubmitTokenPayload(action.payload);
  const result = record(action.result);
  const answers = record(interaction.result).answers;
  const resolvedAt =
    interaction.resolvedAt instanceof Date
      ? interaction.resolvedAt
      : new Date(interaction.resolvedAt ?? Number.NaN);
  if (
    !payload ||
    interaction.status !== "answered" ||
    action.providerActionId !== payload.formActionId ||
    payload.interactionId !== interaction.id ||
    result.code !== "question_form_answered" ||
    result.interactionId !== interaction.id ||
    !Number.isFinite(resolvedAt.getTime()) ||
    !Array.isArray(answers) ||
    answers.length !== payload.fields.length
  )
    return false;

  const answerByQuestionId = new Map<string, Record<string, unknown>>();
  for (const value of answers) {
    const answer = record(value);
    const questionId =
      typeof answer.questionId === "string" ? answer.questionId : null;
    if (!questionId || answerByQuestionId.has(questionId)) return false;
    answerByQuestionId.set(questionId, answer);
  }
  const values: Record<string, string> = {};
  for (const field of payload.fields) {
    const answer = answerByQuestionId.get(field.questionId);
    if (!answer) return false;
    const optionIds = ids(answer.optionIds);
    if (
      !Array.isArray(answer.optionIds) ||
      optionIds.length !== answer.optionIds.length
    )
      return false;
    if (field.kind === "single_select") {
      if (
        optionIds.length > 1 ||
        (answer.otherText !== undefined &&
          answer.otherText !== null &&
          answer.otherText !== "")
      )
        return false;
      const option = optionIds[0]
        ? field.options.find((candidate) => candidate.optionId === optionIds[0])
        : null;
      if (optionIds.length === 1 && !option) return false;
      values[field.fieldId] = option?.value ?? "";
      continue;
    }
    if (
      optionIds.length !== 0 ||
      (answer.otherText !== undefined &&
        answer.otherText !== null &&
        typeof answer.otherText !== "string")
    )
      return false;
    values[field.fieldId] =
      typeof answer.otherText === "string" ? answer.otherText : "";
  }
  const validation = validateChatQuestionFormSubmission({
    callbackId: payload.formActionId,
    privateMetadata: payload.formActionId,
    interaction: { ...interaction, status: "pending" },
    payload,
    values,
    // Recheck the durable answer time against the opaque token's lifetime;
    // continuing later must not depend on the current wall clock.
    now: resolvedAt,
  });
  return (
    validation.ok &&
    nativeSha256(validation.answers) === nativeSha256(answers)
  );
}
