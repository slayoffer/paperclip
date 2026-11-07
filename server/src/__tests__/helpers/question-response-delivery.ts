import { randomUUID } from "node:crypto";
import { agents, companies, createDb, goals, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";

export async function seedQuestionResponseDelivery(
  db: ReturnType<typeof createDb>,
  args: {
    adapterType?: string;
    runtimeMode?: "legacy" | "native";
    sourceStatus?: string;
    successorStatus?: "queued" | "running";
    sourceCommentBody?: string;
    attachSourceCommentToInteraction?: boolean;
    syntheticCustomOption?: boolean;
    resolverPolicy?: "anyone" | "not_creator" | "human_only";
  } = {},
) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const goalId = randomUUID();
  const issueId = randomUUID();
  const sourceRunId = randomUUID();
  const successorRunId = args.successorStatus ? randomUUID() : null;
  await db.insert(companies).values({
    id: companyId,
    name: "Question delivery",
    issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Runner",
    role: "engineer",
    status: "active",
    adapterType: args.adapterType ?? "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(goals).values({
    id: goalId,
    companyId,
    title: "Test",
    level: "task",
    status: "active",
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    goalId,
    title: "Deliver answers",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: agentId,
  });
  await db.insert(heartbeatRuns).values({
    id: sourceRunId,
    companyId,
    agentId,
    invocationSource: "manual",
    status: args.sourceStatus ?? "succeeded",
    runtimeMode: args.runtimeMode ?? "native",
    driverKind: "codex",
    contextSnapshot: { issueId },
    ...(args.sourceStatus === "running"
      ? { startedAt: new Date() }
      : { finishedAt: new Date() }),
  });
  if (successorRunId && args.successorStatus) {
    await db.insert(heartbeatRuns).values({
      id: successorRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: args.successorStatus,
      runtimeMode: args.runtimeMode ?? "native",
      driverKind: "codex",
      contextSnapshot: { issueId },
      ...(args.successorStatus === "running"
        ? { startedAt: new Date() }
        : {}),
    });
  }

  const sourceCommentId = args.sourceCommentBody ? randomUUID() : null;
  if (sourceCommentId) {
    await db.insert(issueComments).values({
      id: sourceCommentId,
      companyId,
      issueId,
      authorUserId: "external-user",
      body: args.sourceCommentBody!,
    });
  }

  const interactionSvc = issueThreadInteractionService(db);
  const interaction = await interactionSvc.create(
    { id: issueId, companyId },
    {
      kind: "ask_user_questions",
      ...(args.resolverPolicy ? { resolverPolicy: args.resolverPolicy } : {}),
      continuationPolicy: "wake_assignee",
      sourceCommentId:
        args.attachSourceCommentToInteraction === false
          ? null
          : sourceCommentId,
      sourceRunId,
      payload: {
        version: 1,
        title: "Server choices",
        questions: [
          {
            id: "purpose",
            prompt: "What is it for?",
            selectionMode: "single",
            required: true,
            options: [
              { id: "custom", label: "Write an answer", freeText: true },
            ],
          },
          {
            id: "runtime",
            prompt: "Which runtime?",
            selectionMode: "single",
            required: true,
            options: [
              { id: "node", label: "Node.js" },
              { id: "bun", label: "Bun" },
            ],
          },
          {
            id: "features",
            prompt: "Which features?",
            selectionMode: "multi",
            allowOther: true,
            options: [
              { id: "health", label: "Health check" },
              { id: "logs", label: "Request logs" },
              ...(args.syntheticCustomOption
                ? [{ id: "features-custom", label: "Other", freeText: true as const }]
                : []),
            ],
          },
        ],
        questionSet: {
          schema: "paperclip.question_set.v1",
          title: "Server choices",
          questions: [
            {
              id: "purpose",
              header: "Purpose",
              prompt: "What is it for?",
              required: true,
              answerMode: "text",
            },
            {
              id: "runtime",
              header: "Runtime",
              prompt: "Which runtime?",
              required: true,
              answerMode: "single_select",
              options: [
                { id: "node", label: "Node.js" },
                { id: "bun", label: "Bun" },
              ],
            },
            {
              id: "features",
              header: "Features",
              prompt: "Which features?",
              required: false,
              answerMode: "multi_select",
              options: [
                { id: "health", label: "Health check" },
                { id: "logs", label: "Request logs" },
              ],
              customAnswer: { enabled: true, label: "Other" },
            },
          ],
        },
      },
    },
    { agentId, runId: sourceRunId },
  );
  const answered = await interactionSvc.answerQuestions(
    { id: issueId, companyId, status: "in_progress" },
    interaction.id,
    {
      answers: [
        { questionId: "purpose", optionIds: [], otherText: "Internal API" },
        { questionId: "runtime", optionIds: ["node"] },
        {
          questionId: "features",
          optionIds: ["health", "logs", ...(args.syntheticCustomOption ? ["features-custom"] : [])],
          otherText: "Metrics",
        },
      ],
    },
    { userId: "board-user" },
  );
  return {
    companyId,
    agentId,
    issueId,
    sourceRunId,
    sourceCommentId,
    successorRunId,
    interaction: answered,
  };
}
