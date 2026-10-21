import type { AcceptIssueThreadInteraction, AskUserQuestionsAnswer, AskUserQuestionsInteraction, IssueThreadInteractionCanonicalResolverPolicy, RequestCheckboxConfirmationInteraction, RequestItemVerdictsInteraction, RequestItemVerdictsResultItem, RespondIssueThreadInteraction, SuggestTasksInteraction, SubmitIssueThreadInteractionVerdicts } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { type IssueThreadInteractionResolverRestriction } from "./issue-thread-interaction-resolution.js";

export type InteractionActor = {
  identityContextId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  userId?: string | null;
  systemId?: string | null;
  resolverPolicyRestriction?:
    | IssueThreadInteractionCanonicalResolverPolicy
    | IssueThreadInteractionResolverRestriction
    | null;
  suggestedTaskEffectsAuthorized?: boolean;
  resolutionDetails?: Record<string, unknown>;
};

export function buildTaskCreationOrder(
  tasks: ReadonlyArray<SuggestTasksInteraction["payload"]["tasks"][number]>,
) {
  const taskByClientKey = new Map(
    tasks.map((task) => [task.clientKey, task] as const),
  );
  const ordered: Array<SuggestTasksInteraction["payload"]["tasks"][number]> =
    [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (clientKey: string) => {
    const currentState = state.get(clientKey);
    if (currentState === "done") return;
    if (currentState === "visiting") {
      throw unprocessable("Suggested tasks contain a parentClientKey cycle");
    }

    const task = taskByClientKey.get(clientKey);
    if (!task) {
      throw unprocessable(`Unknown parentClientKey: ${clientKey}`);
    }

    state.set(clientKey, "visiting");
    if (task.parentClientKey) {
      visit(task.parentClientKey);
    }
    state.set(clientKey, "done");
    ordered.push(task);
  };

  for (const task of tasks) {
    visit(task.clientKey);
  }

  return ordered;
}

export function resolveSelectedSuggestedTasks(args: {
  interaction: SuggestTasksInteraction;
  selectedClientKeys?: AcceptIssueThreadInteraction["selectedClientKeys"];
}) {
  const taskByClientKey = new Map(
    args.interaction.payload.tasks.map(
      (task) => [task.clientKey, task] as const,
    ),
  );
  const selectedClientKeys =
    args.selectedClientKeys ??
    args.interaction.payload.tasks.map((task) => task.clientKey);
  const selectedClientKeySet = new Set<string>();

  for (const clientKey of selectedClientKeys) {
    const task = taskByClientKey.get(clientKey);
    if (!task) {
      throw unprocessable(`Unknown suggested task clientKey: ${clientKey}`);
    }
    selectedClientKeySet.add(clientKey);
  }

  if (selectedClientKeySet.size === 0) {
    throw unprocessable("Select at least one suggested task to accept");
  }

  for (const clientKey of selectedClientKeySet) {
    let parentClientKey =
      taskByClientKey.get(clientKey)?.parentClientKey ?? null;
    while (parentClientKey) {
      if (!selectedClientKeySet.has(parentClientKey)) {
        throw unprocessable(
          `Suggested task ${clientKey} requires its parent ${parentClientKey} to also be selected`,
        );
      }
      parentClientKey =
        taskByClientKey.get(parentClientKey)?.parentClientKey ?? null;
    }
  }

  return {
    selectedTasks: args.interaction.payload.tasks.filter((task) =>
      selectedClientKeySet.has(task.clientKey),
    ),
    skippedClientKeys: args.interaction.payload.tasks
      .filter((task) => !selectedClientKeySet.has(task.clientKey))
      .map((task) => task.clientKey),
  };
}

export function resolveSelectedCheckboxConfirmationOptions(args: {
  interaction: RequestCheckboxConfirmationInteraction;
  selectedOptionIds?: AcceptIssueThreadInteraction["selectedOptionIds"];
}) {
  const optionIds = new Set(
    args.interaction.payload.options.map((option) => option.id),
  );
  const selectedOptionIds =
    args.selectedOptionIds ??
    args.interaction.payload.defaultSelectedOptionIds ??
    [];
  const selectedOptionIdSet = new Set<string>();

  for (const optionId of selectedOptionIds) {
    if (!optionIds.has(optionId)) {
      throw unprocessable(
        `Unknown checkbox confirmation optionId: ${optionId}`,
      );
    }
    selectedOptionIdSet.add(optionId);
  }

  const selectedCount = selectedOptionIdSet.size;
  const minSelected = args.interaction.payload.minSelected ?? 0;
  const maxSelected = args.interaction.payload.maxSelected ?? null;
  if (selectedCount < minSelected) {
    throw unprocessable(
      `Select at least ${minSelected} checkbox confirmation option(s)`,
    );
  }
  if (maxSelected != null && selectedCount > maxSelected) {
    throw unprocessable(
      `Select no more than ${maxSelected} checkbox confirmation option(s)`,
    );
  }

  return args.interaction.payload.options
    .filter((option) => selectedOptionIdSet.has(option.id))
    .map((option) => option.id);
}

export function resolveRequestItemVerdictSubmissions(args: {
  interaction: RequestItemVerdictsInteraction;
  input: SubmitIssueThreadInteractionVerdicts;
  actor: InteractionActor;
  now: Date;
}) {
  const existingItems = args.interaction.result?.items ?? [];
  const existingById = new Map(
    existingItems.map((item) => [item.id, item] as const),
  );
  const payloadItemIds = new Set(
    args.interaction.payload.items.map((item) => item.id),
  );
  const enabledVerdicts = new Set(
    args.interaction.payload.verdicts ?? ["approve", "reject"],
  );
  const requireReasonOn = new Set(
    args.interaction.payload.requireReasonOn ?? ["reject"],
  );
  const newlyResolvedById = new Map<string, RequestItemVerdictsResultItem>();
  const newlyResolvedItemIds: string[] = [];

  for (const submitted of args.input.verdicts) {
    if (!payloadItemIds.has(submitted.id)) {
      throw unprocessable(`Unknown item verdict id: ${submitted.id}`);
    }
    if (existingById.has(submitted.id)) {
      continue;
    }
    if (!enabledVerdicts.has(submitted.verdict)) {
      throw unprocessable(
        `Verdict ${submitted.verdict} is not enabled for this item verdict request`,
      );
    }

    const reason = submitted.reason?.trim() ?? "";
    if (requireReasonOn.has(submitted.verdict) && reason.length === 0) {
      throw unprocessable(
        `A reason is required when verdict is ${submitted.verdict}`,
      );
    }

    if (newlyResolvedById.has(submitted.id)) {
      continue;
    }
    newlyResolvedById.set(submitted.id, {
      id: submitted.id,
      verdict: submitted.verdict,
      ...(reason ? { reason } : {}),
      ...(args.actor.userId ? { resolvedByUserId: args.actor.userId } : {}),
      ...(args.actor.agentId ? { resolvedByAgentId: args.actor.agentId } : {}),
      ...(args.actor.runId ? { resolvedByRunId: args.actor.runId } : {}),
      resolvedAt: args.now,
    });
    newlyResolvedItemIds.push(submitted.id);
  }

  const nextById = new Map<string, RequestItemVerdictsResultItem>(
    existingItems.map((item) => [item.id, item]),
  );
  for (const [id, item] of newlyResolvedById) {
    nextById.set(id, item);
  }
  const items = args.interaction.payload.items
    .map((item) => nextById.get(item.id))
    .filter((item): item is RequestItemVerdictsResultItem => Boolean(item));

  return {
    items,
    complete: items.length === args.interaction.payload.items.length,
    newlyResolvedItemIds,
  };
}

export function normalizeQuestionAnswers(args: {
  questions: AskUserQuestionsInteraction["payload"]["questions"];
  answers: RespondIssueThreadInteraction["answers"];
}) {
  const questionById = new Map(
    args.questions.map((question) => [question.id, question] as const),
  );
  const answerByQuestionId = new Map<string, AskUserQuestionsAnswer>();

  for (const answer of args.answers) {
    const question = questionById.get(answer.questionId);
    if (!question) {
      throw unprocessable(`Unknown questionId: ${answer.questionId}`);
    }
    if (answerByQuestionId.has(answer.questionId)) {
      throw unprocessable(
        `Duplicate answer for questionId: ${answer.questionId}`,
      );
    }

    const uniqueOptionIds = [...new Set(answer.optionIds)];
    const validOptionIds = new Set(question.options.map((option) => option.id));
    for (const optionId of uniqueOptionIds) {
      if (!validOptionIds.has(optionId)) {
        throw unprocessable(
          `Unknown optionId for question ${answer.questionId}: ${optionId}`,
        );
      }
    }

    if (question.selectionMode === "single" && uniqueOptionIds.length > 1) {
      throw unprocessable(
        `Question ${answer.questionId} only allows one answer`,
      );
    }

    const otherText = answer.otherText?.trim() ?? "";
    if (!otherText && question.options.some((option) => option.freeText && uniqueOptionIds.includes(option.id))) {
      throw unprocessable(
        `Question ${answer.questionId} requires text for the selected free-text option. ` +
        'Send {questionId, text} or {questionId, optionIds, otherText} in answers. summaryMarkdown does not answer a question.',
        { code: "invalid_question_response" },
      );
    }
    answerByQuestionId.set(answer.questionId, {
      questionId: answer.questionId,
      optionIds: uniqueOptionIds,
      ...(otherText ? { otherText } : {}),
    });
  }

  for (const question of args.questions) {
    const answer = answerByQuestionId.get(question.id);
    if (
      question.required &&
      (!answer || (answer.optionIds.length === 0 && !answer.otherText))
    ) {
      throw unprocessable(
        `Question ${question.id} requires an answer. ` +
        'Send {questionId, optionIds} for a listed choice. Send {questionId, text} or {questionId, optionIds, otherText} for text.',
        { code: "invalid_question_response" },
      );
    }
  }

  return args.questions
    .map((question) => answerByQuestionId.get(question.id))
    .filter((answer): answer is AskUserQuestionsAnswer => Boolean(answer));
}
