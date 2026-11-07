import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  activityLog, agentWakeupRequests, chatConversations, chatDeliveries,
  chatEndpoints, chatExternalPrincipals, chatIdentityLinks, chatMessageLinks,
  chatPublications, createDb, heartbeatRuns, issueComments, toolApplications, toolConnections,
  issueQuestionResponseDeliveries, issueThreadInteractions,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedQuestionResponseDelivery } from "./helpers/question-response-delivery.js";
import {
  buildQuestionResponseDeliveryEnvelope,
  isRetiredExternalChatQuestionSource,
} from "../services/question-response-delivery.js";
import { nativeSha256 } from "../services/native-runtime/canonical.js";
import { resolveExternalChatQuestionResponse } from "../services/native-runtime/external-chat-question-response.js";

describe("legacy question response authorization", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("question-legacy-authorization-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await temporary?.cleanup(); });

  async function seed(format: "current" | "legacy") {
    const fixture = await seedQuestionResponseDelivery(db, {
      syntheticCustomOption: true, sourceCommentBody: "Continue after my answer.",
      successorStatus: "running",
    });
    const envelope = buildQuestionResponseDeliveryEnvelope(fixture.interaction);
    const stored = structuredClone(envelope);
    if (format === "legacy") {
      stored.response.answers.features.selectedOptionIds = ["health", "logs", "features-custom"];
      expect(nativeSha256(stored)).not.toBe(nativeSha256(envelope));
    }
    const digest = nativeSha256(stored);
    const [delivery] = await db.update(issueQuestionResponseDeliveries).set({
      payloadSha256: digest, status: "fallback_queued", deliveryMode: "wake_fallback",
      targetRunId: fixture.successorRunId,
    }).where(eq(issueQuestionResponseDeliveries.interactionId, fixture.interaction.id)).returning();
    const intentAuditId = randomUUID();
    const acknowledgementAuditId = randomUUID();
    const intentId = randomUUID();
    for (const [id, action, details] of [
      [intentAuditId, "native.cancellation_intent_recorded", { intentId, scope: "run" }],
      [acknowledgementAuditId, "native.cancellation_dispatch_acknowledged", { intentId, intentAuditId, scope: "run" }],
    ] as const) {
      await db.insert(activityLog).values({
        id, companyId: fixture.companyId, agentId: fixture.agentId, runId: fixture.sourceRunId,
        entityType: "heartbeat_run", entityId: fixture.sourceRunId,
        actorType: "system", actorId: "native-session-cancellation", action, details,
      });
    }
    await db.update(heartbeatRuns).set({
      nativeIssueId: fixture.issueId, status: "cancelled", errorCode: "external_chat_continuation",
      contextSnapshot: {
        source: "chat:github", issueId: fixture.issueId,
        wakeCommentIds: [fixture.sourceCommentId], paperclipHarnessCheckedOut: true,
        paperclipWake: { externalChatProvider: "github", checkedOutByHarness: true },
      },
      resultJson: {
        externalChatContinuation: true, interactionId: fixture.interaction.id,
        nativeCancellation: {
          schema: "paperclip.native-cancellation.v1", companyId: fixture.companyId,
          runId: fixture.sourceRunId, issueId: fixture.issueId, scope: "run",
          dispatchState: "acknowledged", intentId, intentAuditId, acknowledgementAuditId,
        },
      },
    }).where(eq(heartbeatRuns.id, fixture.sourceRunId));
    const context = {
      source: "issue.interaction.respond", issueId: fixture.issueId,
      wakeReason: "issue_commented", interactionId: fixture.interaction.id,
      interactionKind: "ask_user_questions", interactionStatus: "answered",
      externalChatContinuation: true, sourceRunId: fixture.sourceRunId,
      sourceCommentId: fixture.sourceCommentId, wakeCommentId: fixture.sourceCommentId,
      wakeCommentIds: [fixture.sourceCommentId],
    };
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId, companyId: fixture.companyId, agentId: fixture.agentId,
      runId: fixture.successorRunId, source: "automation", reason: "issue_commented",
      status: "claimed", requestedByActorType: "user", requestedByActorId: "board-user",
      idempotencyKey: `question-response:${fixture.interaction.id}`,
      payload: { ...context },
    });
    await db.update(heartbeatRuns).set({ wakeupRequestId: wakeId, contextSnapshot: context })
      .where(eq(heartbeatRuns.id, fixture.successorRunId!));
    return { ...fixture, context, digest, deliveryId: delivery!.id, intentAuditId, wakeId };
  }

  async function addChatEvidence(fixture: Awaited<ReturnType<typeof seed>>) {
    const endpointId = randomUUID();
    const conversationId = randomUUID();
    const principalId = randomUUID();
    const inboundId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    await db.insert(toolApplications).values({
      id: applicationId, companyId: fixture.companyId, applicationKey: `chat:${endpointId}`,
      name: "Test GitHub", type: "chat", status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId, companyId: fixture.companyId, applicationId, name: "Test GitHub",
      uid: `chat-${endpointId}`, connectionPurpose: "channel", transport: "chat_sdk", status: "active",
    });
    await db.insert(chatEndpoints).values({
      id: endpointId, connectionId, companyId: fixture.companyId, provider: "github", publicId: randomUUID(),
      assignedAgentId: fixture.agentId, status: "active", setup: { runtimeGeneration: 1 },
    });
    await db.insert(chatConversations).values({
      id: conversationId, companyId: fixture.companyId, endpointId,
      issueId: fixture.issueId, externalConversationId: "test-thread", externalLabel: "Test thread", state: "active",
    });
    await db.insert(chatExternalPrincipals).values({
      id: principalId, companyId: fixture.companyId, provider: "github",
      providerAccountId: "test-account", externalId: "test-user", kind: "user",
    });
    await db.insert(chatIdentityLinks).values({
      companyId: fixture.companyId, endpointId, principalId,
      paperclipUserId: "board-user", status: "linked",
    });
    await db.update(issueComments).set({ authorUserId: "board-user" })
      .where(eq(issueComments.id, fixture.sourceCommentId!));
    await db.insert(chatDeliveries).values({
      id: inboundId, companyId: fixture.companyId, endpointId, conversationId, principalId,
      providerEventId: "test-event", deduplicationKey: "test-event", eventKind: "message",
      state: "processed", normalizedEvent: {
        runtimeContext: { generation: 1, credentialFingerprint: "a".repeat(64) },
      },
    });
    await db.insert(chatMessageLinks).values({
      companyId: fixture.companyId, endpointId, conversationId, deliveryId: inboundId,
      commentId: fixture.sourceCommentId, providerMessageId: "test-message", direction: "inbound",
    });
    await db.insert(chatPublications).values({
      companyId: fixture.companyId, endpointId, conversationId, issueId: fixture.issueId,
      state: "published", providerMessageId: "test-question",
      idempotencyKey: `interaction:${fixture.interaction.id}:${endpointId}`,
      publishedAt: new Date(fixture.interaction.resolvedAt!.getTime() - 1000),
      payload: {
        interactionId: fixture.interaction.id, progressState: "waiting_for_input",
        card: { kind: "question", actions: [{ type: "link", url: "https://board.example" }] },
      } as never,
    });
    return { endpointId, principalId };
  }

  it.each(["current", "legacy"] as const)("authorizes a %s custom-answer continuation", async (format) => {
    const fixture = await seed(format);
    await addChatEvidence(fixture);
    const result = await resolveExternalChatQuestionResponse(db, {
      ...fixture, runId: fixture.successorRunId!,
    }, fixture.context, "read", true);
    expect(result).not.toBeNull();
    expect(result!.marker.responseDeliveryId).toBe(fixture.deliveryId);
    expect(result!.interactionIds).toEqual([fixture.interaction.id]);
    const [delivery] = await db.select().from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.id, fixture.deliveryId));
    expect(delivery!.payloadSha256).toBe(fixture.digest);
  });

  it.each(["current", "legacy"] as const)("recognizes a retired source with a %s digest", async (format) => {
    const fixture = await seed(format);
    expect(await isRetiredExternalChatQuestionSource(db, {
      ...fixture, runId: fixture.sourceRunId,
    })).toBe(true);
  });

  it.each(["digest", "answer", "correlation", "actor", "company"] as const)(
    "rejects a legacy continuation with an altered %s", async (change) => {
      const fixture = await seed("legacy");
      await addChatEvidence(fixture);
      if (change === "digest" || change === "correlation") {
        await db.update(issueQuestionResponseDeliveries).set(change === "digest"
          ? { payloadSha256: "0".repeat(64) } : { correlationId: `wrong-${fixture.deliveryId}` })
          .where(eq(issueQuestionResponseDeliveries.id, fixture.deliveryId));
      }
      if (change === "answer") {
        const result = structuredClone(fixture.interaction.result!);
        result.answers[2].otherText = "Altered answer";
        await db.update(issueThreadInteractions).set({ result })
          .where(eq(issueThreadInteractions.id, fixture.interaction.id));
      }
      if (change === "actor") {
        await db.update(agentWakeupRequests).set({ requestedByActorId: "another-user" })
          .where(eq(agentWakeupRequests.id, fixture.wakeId));
      }
      expect(await resolveExternalChatQuestionResponse(db, {
        ...fixture, companyId: change === "company" ? randomUUID() : fixture.companyId,
        runId: fixture.successorRunId!,
      }, fixture.context, "read", true)).toBeNull();
    },
  );

  it.each(["digest", "answer", "correlation", "audit", "company", "cancellation"] as const)(
    "rejects a retired legacy source with an altered %s", async (change) => {
      const fixture = await seed("legacy");
      if (change === "digest" || change === "correlation") {
        await db.update(issueQuestionResponseDeliveries).set(change === "digest"
          ? { payloadSha256: "0".repeat(64) } : { correlationId: `wrong-${fixture.deliveryId}` })
          .where(eq(issueQuestionResponseDeliveries.id, fixture.deliveryId));
      }
      if (change === "answer") {
        const result = structuredClone(fixture.interaction.result!);
        result.answers[2].otherText = "Altered answer";
        await db.update(issueThreadInteractions).set({ result })
          .where(eq(issueThreadInteractions.id, fixture.interaction.id));
      }
      if (change === "audit") await db.delete(activityLog).where(eq(activityLog.id, fixture.intentAuditId));
      if (change === "cancellation") await db.update(heartbeatRuns).set({ resultJson: {} })
        .where(eq(heartbeatRuns.id, fixture.sourceRunId));
      expect(await isRetiredExternalChatQuestionSource(db, {
        ...fixture, companyId: change === "company" ? randomUUID() : fixture.companyId,
        runId: fixture.sourceRunId,
      })).toBe(false);
    },
  );
});
