import { createHash } from "node:crypto";
import { issueThreadInteractions, issues, toolOauthCardProjections, type Db } from "@paperclipai/db";
import { connectionIntentPayloadSchema } from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../../../middleware/logger.js";
import type { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import { isInteractionCardWipRefusal, writeInteractionCardStatus } from "../../interaction-card-status.js";
import { notifyIssueReviewState } from "../../issue-review-state-notifications.js";
import { registerScopedDeadlineWork } from "../../scoped-deadline-work.js";
import type { ActorInfo, DbTransaction } from "../types.js";

type CardProjection = typeof toolOauthCardProjections.$inferSelect;
type CallbackCard = { companyId: string; interactionId: string | null };

function targetOAuthState(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("target" in payload)) return null;
  const { target } = payload;
  return target && typeof target === "object" && "key" in target &&
    typeof target.key === "string" && target.key.startsWith("connection:") &&
    "revisionId" in target && typeof target.revisionId === "string"
    ? target.revisionId
    : null;
}

function cardGeneration(card: { payload: unknown; revision: string }) {
  const state = targetOAuthState(card.payload);
  // A renewed authorization can reuse the same interaction ID. Hash the
  // target state so the outbox does not retain a replay credential.
  return state ? `oauth:${createHash("sha256").update(state).digest("hex")}` : `card:${card.revision}`;
}

function callbackActor(actor: ActorInfo | undefined) {
  return {
    actorType: actor?.actorType === "user" ? "board" : actor?.actorType ?? "system",
    actorSource: actor?.actorSource ?? null,
  };
}

async function findPendingCard(tx: Pick<Db, "select">, companyId: string, interactionId: string) {
  const [card] = await tx.select({
    id: issueThreadInteractions.id,
    revision: issueThreadInteractions.revision,
    issueId: issueThreadInteractions.issueId,
    kind: issueThreadInteractions.kind,
    payload: issueThreadInteractions.payload,
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, interactionId),
    eq(issueThreadInteractions.companyId, companyId),
    eq(issueThreadInteractions.status, "pending"),
  ));
  return card;
}

function makeProjection(
  scope: { companyId: string; interactionId: string; issueId: string; cardGeneration: string },
  outcome: CardProjection["outcome"],
  actor: ActorInfo | undefined,
  resolvedByUserId: string | null,
) {
  return { ...scope, outcome, ...callbackActor(actor), resolvedByUserId, createdAt: new Date() };
}

/** Called in the transaction consuming denials or completing provider credentials. */
export async function recordOAuthCardOutcome(
  tx: DbTransaction,
  scope: CallbackCard & { state: string },
  outcome: CardProjection["outcome"],
  actor: ActorInfo | undefined,
  resolvedByUserId = actor?.actorType === "user" ? actor.actorId ?? null : null,
) {
  if (!scope.interactionId) return;
  const card = await findPendingCard(tx, scope.companyId, scope.interactionId);
  if (!card || (outcome === "accepted" && card.kind !== "request_confirmation")) return;
  const targetState = targetOAuthState(card.payload);
  if (targetState !== null && targetState !== scope.state) return;
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.oauthCardProjection, scope.companyId);
  await tx.insert(toolOauthCardProjections).values(makeProjection({
    companyId: scope.companyId, interactionId: card.id, issueId: card.issueId, cardGeneration: cardGeneration(card),
  }, outcome, actor, resolvedByUserId)).onConflictDoNothing();
}

async function writeOAuthCardOutcome(tx: DbTransaction, projection: CardProjection) {
  const { interactionId, companyId, issueId, outcome, actorType, actorSource, resolvedByUserId, createdAt } = projection;
  const [card] = await tx.select({
    revision: issueThreadInteractions.revision,
    kind: issueThreadInteractions.kind,
    payload: issueThreadInteractions.payload,
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, interactionId),
    eq(issueThreadInteractions.companyId, companyId),
    eq(issueThreadInteractions.issueId, issueId),
    eq(issueThreadInteractions.status, "pending"),
  )).for("update");
  if (!card || cardGeneration(card) !== projection.cardGeneration) return;
  const pendingCard = and(eq(issueThreadInteractions.id, interactionId), eq(issueThreadInteractions.status, "pending"));
  if (card.kind === "connection_intent" && outcome === "rejected") {
    const payload = connectionIntentPayloadSchema.parse(card.payload);
    await tx.update(issueThreadInteractions).set({
      payload: { ...payload, phase: "needs_retry" },
      updatedAt: new Date(),
    }).where(and(eq(issueThreadInteractions.companyId, companyId), pendingCard));
    return;
  }
  await notifyIssueReviewState(tx, { companyId, issueId });
  await writeInteractionCardStatus(tx, {
    issue: { id: issueId, companyId },
    actor: { type: actorType, source: actorSource ?? undefined },
    where: pendingCard,
    values: {
      status: outcome,
      result: outcome === "rejected"
        ? { version: 1, outcome, reason: "Authorization was declined or cancelled in the provider's window" }
        : { version: 1, outcome },
      resolvedByUserId, resolvedAt: createdAt, updatedAt: new Date(),
    },
  });
}

async function lockOAuthCardIssue(tx: DbTransaction, companyId: string, issueId: string) {
  await tx.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update");
}

/** A single transaction applies the outcome and clears the durable row. */
export async function projectOAuthCardOutcome(db: Db, scope: CallbackCard) {
  if (!scope.interactionId) return;
  const filter = and(
    eq(toolOauthCardProjections.companyId, scope.companyId),
    eq(toolOauthCardProjections.interactionId, scope.interactionId),
  );
  await db.transaction(async tx => {
    const [candidate] = await tx.select({ issueId: toolOauthCardProjections.issueId })
      .from(toolOauthCardProjections).where(filter).limit(1);
    if (!candidate) return;
    // Issue deletion cascades through its card. Take locks in that order.
    await lockOAuthCardIssue(tx, scope.companyId, candidate.issueId);
    const projections = await tx.select().from(toolOauthCardProjections).where(filter).for("update");
    for (const projection of projections) {
      await writeOAuthCardOutcome(tx, projection);
      await tx.delete(toolOauthCardProjections).where(and(
        filter, eq(toolOauthCardProjections.cardGeneration, projection.cardGeneration),
      ));
    }
  });
}

/** A foreground callback can settle its card immediately without losing deferred work. */
export async function tryProjectOAuthCardOutcome(db: Db, scope: CallbackCard) {
  try {
    await projectOAuthCardOutcome(db, scope);
  } catch (error) {
    if (!isInteractionCardWipRefusal(error)) {
      logger.warn({ err: error, interactionId: scope.interactionId }, "OAuth card outcome will retry");
    }
  }
}

export function registerOAuthCardProjectionWork(
  db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean,
) {
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.oauthCardProjection,
    batchSize: 20,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: (entry, companyId?: string) => companyId === undefined || companyId === entry.companyId,
    load: async (companyId?: string) => {
      const rows = await db.select({
        id: toolOauthCardProjections.interactionId,
        companyId: toolOauthCardProjections.companyId,
        dueAt: sql<number>`min(extract(epoch from ${toolOauthCardProjections.createdAt})) * 1000`.mapWith(Number),
      }).from(toolOauthCardProjections).where(companyId ? eq(toolOauthCardProjections.companyId, companyId) : undefined)
        .groupBy(toolOauthCardProjections.interactionId, toolOauthCardProjections.companyId);
      return rows;
    },
    mergeEntry: (pending, loaded) => pending.dueAt > loaded.dueAt ? pending : loaded,
    check: async entry => {
      try {
        await projectOAuthCardOutcome(db, { companyId: entry.companyId, interactionId: entry.id });
        return null;
      } catch (error) {
        if (!isInteractionCardWipRefusal(error)) throw error;
        return { ...entry, dueAt: Date.now() + 30_000 };
      }
    },
  }, canRun);
}
