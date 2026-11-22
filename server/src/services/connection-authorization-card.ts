import { and, eq, isNull, sql } from "drizzle-orm";
import { interactionResolutionOutbox, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import type { RequestConfirmationPayload } from "@paperclipai/shared";
import { notFound } from "../errors.js";

type CardInput = Pick<typeof issueThreadInteractions.$inferInsert,
  "companyId" | "issueId" | "sourceRunId" | "title" | "summary" | "createdByAgentId"
> & {
  connectionId: string;
  addresseeUserId: string;
  continuationPolicy?: "wake_assignee";
  payload: RequestConfirmationPayload & { target: NonNullable<RequestConfirmationPayload["target"]> };
};

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const authorizationKeyPrefix = "connection-authorization:";
const retryKeyPrefix = "connection-authorization-retry:";

export function isConnectionAuthorizationCardKey(key: string) {
  return key.startsWith(authorizationKeyPrefix) || key.startsWith(retryKeyPrefix);
}

export async function requestConnectionAuthorizationCard(
  db: Transaction,
  input: CardInput,
) {
  const { connectionId, continuationPolicy: requestedContinuation, ...card } = input;
  // Use the same issue-before-interaction lock order as confirmation answers.
  const [issue] = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, card.companyId),
    eq(issues.id, card.issueId),
  )).for("no key update");
  if (!issue) throw notFound("Issue not found");

  const policy = {
    requestedResolverPolicy: "human_only",
    effectiveResolverPolicy: "human_only",
    resolverPolicyProvenance: "explicit",
    effectiveResolverPolicySource: "requested",
  } as const;
  let key = `${authorizationKeyPrefix}${connectionId}:${card.addresseeUserId}`;
  let previousContinuation = "none";

  // Each completed card identifies its successor through the existing unique index.
  for (;;) {
    const scope = and(
      eq(issueThreadInteractions.companyId, card.companyId),
      eq(issueThreadInteractions.issueId, card.issueId),
      eq(issueThreadInteractions.idempotencyKey, key),
    );
    const [existing] = await db.select({
      id: issueThreadInteractions.id,
      status: issueThreadInteractions.status,
      resolvedAt: issueThreadInteractions.resolvedAt,
      continuationPolicy: issueThreadInteractions.continuationPolicy,
      kind: issueThreadInteractions.kind,
      addresseeUserId: issueThreadInteractions.addresseeUserId,
      matchesTarget: sql<boolean>`${issueThreadInteractions.payload}->'target'->>'key' = ${card.payload.target.key}`,
      hasAnswer: sql<boolean>`${issueThreadInteractions.resolutionRequest} IS NOT NULL OR EXISTS (
        SELECT 1 FROM ${interactionResolutionOutbox}
        WHERE ${interactionResolutionOutbox.interactionId} = ${issueThreadInteractions.id}
      )`,
    }).from(issueThreadInteractions).where(scope).limit(1);

    if (!existing) {
      const [created] = await db.insert(issueThreadInteractions).values({
        ...card,
        ...policy,
        kind: "request_confirmation",
        idempotencyKey: key,
        continuationPolicy: requestedContinuation ?? previousContinuation,
      }).onConflictDoNothing({
        target: [
          issueThreadInteractions.companyId,
          issueThreadInteractions.issueId,
          issueThreadInteractions.idempotencyKey,
        ],
        where: sql`${issueThreadInteractions.idempotencyKey} IS NOT NULL`,
      }).returning({ id: issueThreadInteractions.id });
      if (created) return created;
      continue;
    }

    if (existing.kind !== "request_confirmation" ||
      existing.addresseeUserId !== card.addresseeUserId ||
      !existing.matchesTarget) {
      // An unrelated interaction can already own this idempotency key.
      key = `${retryKeyPrefix}${existing.id}`;
      continue;
    }

    const pending = and(
      scope,
      eq(issueThreadInteractions.id, existing.id),
      eq(issueThreadInteractions.status, "pending"),
      isNull(issueThreadInteractions.resolvedAt),
    );
    if (existing.status !== "pending" || existing.resolvedAt !== null || existing.hasAnswer) {
      if (existing.status === "pending" && existing.resolvedAt === null) {
        // Older writers cleared the result but left the answer receipt or outbox entry.
        const now = new Date();
        await db.update(issueThreadInteractions).set({
          status: "expired",
          result: { version: 1, outcome: "expired", reason: "A new authorization request replaced this card" },
          resolvedAt: now,
          updatedAt: now,
        }).where(pending);
      }
      previousContinuation = existing.continuationPolicy;
      key = `${retryKeyPrefix}${existing.id}`;
      continue;
    }

    const [updated] = await db.update(issueThreadInteractions).set({
      ...policy,
      continuationPolicy: requestedContinuation,
      addresseeUserId: card.addresseeUserId,
      payload: card.payload,
      updatedAt: new Date(),
    }).where(pending).returning({ id: issueThreadInteractions.id });
    // An OAuth callback can finish the card without acquiring the issue lock.
    if (updated) return updated;
  }
}
