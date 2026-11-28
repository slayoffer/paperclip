import { randomUUID } from "node:crypto";
import { agents, companies, createDb, issueQuestionResponseDeliveries, issues, issueThreadInteractions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { interactionResolutionMutationOptions } from "../services/interaction-resolution-mutation-options.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const human = { userId: "wip-card-fixture" };
const boardKey = { type: "board", source: "board_key", userId: human.userId } as const;
const refusal = { status: 409, details: { code: "agent_wip_limit" } };

describe.skipIf(!support.supported)("WIP admission for issue-thread card resolution", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_WIP_LIMIT", "1");
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-card-wip-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await db?.$client.end();
      await temporary?.cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  async function fixture(atCapacity = true, kind: "ask_user_questions" | "request_confirmation" = "ask_user_questions") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Card WIP fixture", issuePrefix: `WC${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Card owner", adapterType: "process" }).returning();
    if (atCapacity) await db.insert(issues).values({ companyId, status: "todo", assigneeAgentId: agent!.id, title: "Existing work" });
    const [issue] = await db.insert(issues).values({ companyId, status: "blocked", assigneeAgentId: agent!.id, title: "Waiting for a card answer" }).returning();
    const service = issueThreadInteractionService(db);
    const card = await service.create(issue!, kind === "request_confirmation" ? {
      kind, resolverPolicy: "human_only", payload: { version: 1, prompt: "Proceed with the fixture?" },
    } : {
      kind: "ask_user_questions", resolverPolicy: "human_only", payload: {
        version: 1, supersedeOnUserComment: true, questionSet: {
          schema: "paperclip.question_set.v1", questions: [{ id: "scope", prompt: "Select scope", required: true,
            answerMode: "single_select", options: [{ id: "one", label: "One" }] }],
        },
      },
    }, human);
    async function storedCard() {
      return (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id)))[0];
    }
    return { agent: agent!, issue: issue!, card, service, storedCard };
  }

  it("rolls a board-key answer and its outbox back when the owner is full", async () => {
    const { issue, card, service, storedCard } = await fixture();
    const input = { answers: [{ questionId: "scope", optionIds: ["one"] }], expectedRevision: card.revision };
    const options = interactionResolutionMutationOptions(true, async () => {}, boardKey);
    await expect(service.answerQuestions(issue, card.id, input, human, options))
      .rejects.toMatchObject(refusal);
    expect(await storedCard()).toMatchObject({ status: "pending", revision: card.revision, result: null });
    expect(await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.issueId, issue.id))).toHaveLength(0);
  });

  it.each(["acceptInteraction", "rejectInteraction"] as const)("rolls a board-key %s back when the owner is full", async operation => {
    const { issue, card, service, storedCard } = await fixture(true, "request_confirmation");
    const options = interactionResolutionMutationOptions(true, async () => {}, boardKey);
    await expect(service[operation](issue, card.id, { expectedRevision: card.revision }, human, options))
      .rejects.toMatchObject(refusal);
    expect(await storedCard()).toMatchObject({ status: "pending", revision: card.revision, result: null });
    await expect(service[operation](issue, card.id, { expectedRevision: card.revision }, human,
      { wipAdmissionActor: { type: "board", source: "session" } })).resolves.toBeDefined();
    expect(await storedCard()).toMatchObject({ status: operation === "acceptInteraction" ? "accepted" : "rejected" });
  });

  it.each([true, false])("checks the resulting state inside the comment transaction (at capacity: %s)", async atCapacity => {
    const { issue, service, storedCard } = await fixture(atCapacity);
    const comment = { id: randomUUID(), createdAt: new Date(Date.now() + 10_000), authorUserId: human.userId };
    const publish = vi.fn();
    const expire = db.transaction(async transaction => service.expireRequestConfirmationsSupersededByComment(issue, comment,
      human, { transaction, wipAdmissionActor: boardKey, deferConfirmationCommitEffects: publish }));
    if (atCapacity) {
      await expect(expire).rejects.toMatchObject(refusal);
      expect(await storedCard()).toMatchObject({ status: "pending", result: null });
      expect(publish).not.toHaveBeenCalled();
    } else {
      await expect(expire).resolves.toHaveLength(1);
      expect(await storedCard()).toMatchObject({ status: "expired", result: { expirationReason: "superseded_by_comment" } });
      expect(publish).toHaveBeenCalledOnce();
    }
  });

  it("keeps the question pending when an agent posts under user auth", async () => {
    const { agent, issue, service, storedCard } = await fixture();
    await expect(service.expireRequestConfirmationsSupersededByComment(issue, {
      id: randomUUID(), createdAt: new Date(Date.now() + 10_000), authorUserId: human.userId, createdByRunId: randomUUID(),
    }, { ...human, agentId: agent.id })).resolves.toEqual([]);
    expect(await storedCard()).toMatchObject({ status: "pending", result: null });
  });
});
