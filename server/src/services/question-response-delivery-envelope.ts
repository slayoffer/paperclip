import type { AskUserQuestionsInteraction, PaperclipQuestionSetPayload } from "@paperclipai/shared";
import type { PaperclipQuestionResponse } from "../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./native-runtime/canonical.js";

export interface QuestionResponseDeliveryEnvelope {
  schema: "paperclip.question_response_delivery.v1";
  interactionId: string;
  sourceRunId: string | null;
  questionSet: PaperclipQuestionSetPayload;
  response: PaperclipQuestionResponse;
}

function compactLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function canonicalQuestionSet(
  interaction: Pick<AskUserQuestionsInteraction, "title" | "payload">,
): PaperclipQuestionSetPayload {
  if (interaction.payload.questionSet)
    return structuredClone(interaction.payload.questionSet);
  return {
    schema: "paperclip.question_set.v1",
    ...(interaction.title ? { title: interaction.title } : {}),
    ...(interaction.payload.submitLabel
      ? { submitLabel: interaction.payload.submitLabel }
      : {}),
    questions: interaction.payload.questions.map((question) => {
      const customOption = question.options.find(
        (option) => option.freeText === true,
      );
      return {
        id: question.id,
        prompt: question.prompt,
        ...(question.helpText ? { helpText: question.helpText } : {}),
        required: question.required === true,
        answerMode:
          question.selectionMode === "multi"
            ? ("multi_select" as const)
            : ("single_select" as const),
        options: question.options
          .filter((option) => option.freeText !== true)
          .map((option) => ({
            id: option.id,
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
        ...(customOption
          ? {
              customAnswer: {
                enabled: true as const,
                label: customOption.label,
                ...(customOption.description
                  ? { placeholder: customOption.description }
                  : {}),
              },
            }
          : {}),
      };
    }),
  };
}

export function buildQuestionResponseDeliveryEnvelope(
  interaction: AskUserQuestionsInteraction,
): QuestionResponseDeliveryEnvelope {
  if (
    interaction.status !== "answered" ||
    !interaction.result ||
    interaction.result.cancelled === true
  ) {
    throw new Error("question_response_interaction_not_answered");
  }
  const questionSet = canonicalQuestionSet(interaction);
  const questionById = new Map(
    questionSet.questions.map((question) => [question.id, question]),
  );
  const response: PaperclipQuestionResponse = {
    schema: "paperclip.question_response.v1",
    answers: Object.fromEntries(
      interaction.result.answers.map((answer) => {
        const question = questionById.get(answer.questionId);
        const customOptionIds = new Set(
          // A runner question set has no stored free-text options to filter.
          interaction.payload.questions?.find((entry) => entry.id === answer.questionId)
            ?.options.filter((option) => option.freeText).map((option) => option.id) ?? [],
        );
        return [
          answer.questionId,
          question?.answerMode === "text"
            ? { ...(answer.otherText ? { text: answer.otherText } : {}) }
            : {
                selectedOptionIds: answer.optionIds.filter((optionId) => !customOptionIds.has(optionId)),
                ...(answer.otherText ? { customText: answer.otherText } : {}),
              },
        ];
      }),
    ),
  };
  return {
    schema: "paperclip.question_response_delivery.v1",
    interactionId: interaction.id,
    sourceRunId: interaction.sourceRunId ?? null,
    questionSet,
    response,
  };
}

function questionAnswerLines(
  envelope: QuestionResponseDeliveryEnvelope,
): string[] {
  const lines: string[] = [];
  for (const question of envelope.questionSet.questions) {
    const answer = envelope.response.answers[question.id];
    if (!answer) continue;
    const optionLabelById = new Map(
      (question.options ?? []).map((option) => [option.id, option.label]),
    );
    const values = (answer.selectedOptionIds ?? []).map(
      (optionId) => optionLabelById.get(optionId) ?? optionId,
    );
    const text = compactLine(answer.text);
    const customText = compactLine(answer.customText);
    if (text) values.push(text);
    if (customText) values.push(customText);
    const header = compactLine(question.header);
    const prompt = compactLine(question.prompt);
    const label =
      header && prompt && header !== prompt
        ? `${header} — ${prompt}`
        : (header ?? prompt ?? question.id);
    lines.push(`- ${label}: ${values.join(", ") || "No answer"}`);
  }
  return lines;
}

export function formatQuestionResponseSummary(
  envelope: QuestionResponseDeliveryEnvelope,
): string {
  const lines = questionAnswerLines(envelope);
  return lines.length > 0
    ? ["Resolved questions and answers:", ...lines].join("\n")
    : "Resolved questions and answers.";
}

export function formatDurableQuestionResponseSummary(
  interaction: AskUserQuestionsInteraction,
): string {
  const existing = compactLine(interaction.result?.summaryMarkdown);
  return (
    existing ??
    formatQuestionResponseSummary(
      buildQuestionResponseDeliveryEnvelope(interaction),
    )
  );
}

export function formatQuestionResponseSteeringMessage(
  envelope: QuestionResponseDeliveryEnvelope,
): string {
  const lines = questionAnswerLines(envelope);
  return lines.length > 0
    ? ["Answered questions", "", ...lines].join("\n")
    : "Answered questions";
}

/** Accept only the current digest or the exact envelope written before synthetic IDs were removed. */
export function matchesQuestionResponseDeliveryDigest(
  interaction: AskUserQuestionsInteraction,
  envelope: QuestionResponseDeliveryEnvelope,
  expectedDigest: string,
): boolean {
  if (nativeSha256(envelope) === expectedDigest) return true;

  // The previous builder retained every stored option ID for non-text answers.
  // Reconstruct that envelope for comparison. Deliver the current envelope unchanged.
  const legacyEnvelope = structuredClone(envelope);
  const questionById = new Map(envelope.questionSet.questions.map((question) => [question.id, question]));
  for (const answer of interaction.result?.answers ?? []) {
    if (questionById.get(answer.questionId)?.answerMode !== "text") {
      legacyEnvelope.response.answers[answer.questionId].selectedOptionIds = answer.optionIds;
    }
  }
  return nativeSha256(legacyEnvelope) === expectedDigest;
}
