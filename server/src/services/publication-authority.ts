import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { activityLog, publicationRequests, type Db } from "@paperclipai/db";
import {
  publicationBindingsSchema, type PublicationBindings, type PublicationDecision, type PublicationIdentity,
} from "@paperclipai/shared";
import {
  databaseAuthorityClock, lockPublicationBroker, lockPublicationContext, readAuthorityTime,
  type AuthorityClock, type PublicationTransaction,
} from "./publication-authority-context.js";

type Request = typeof publicationRequests.$inferSelect;
type Result = "succeeded" | "refused" | "unknown";

const deny = (reason: string, row?: Request): PublicationDecision => ({
  dispatch: false, state: row?.state ?? "denied", reason, remainingLifetimeMs: 0,
});

/** Offline source service. No production entry point imports or constructs this service. */
export function publicationAuthorityService(db: Db, options: {
  clock?: AuthorityClock;
} = {}) {
  const clock = options.clock ?? databaseAuthorityClock;
  const predicate = (b: PublicationBindings) => and(
    eq(publicationRequests.companyId, b.companyId), eq(publicationRequests.id, b.requestId),
  );

  async function audit(tx: PublicationTransaction, identity: PublicationIdentity, b: PublicationBindings, action: string) {
    await tx.insert(activityLog).values({
      companyId: identity.companyId, actorType: "agent", actorId: identity.agentId,
      agentId: identity.agentId, runId: identity.runId,
      action: `publication.${action}`, entityType: "publication_request", entityId: b.requestId,
      details: { issueId: b.issueId },
    });
  }

  async function lockRequest(tx: PublicationTransaction, identity: PublicationIdentity, b: PublicationBindings) {
    // Clock/broker checks also apply to reports on old requests after reassignment or run completion.
    if (b.companyId !== identity.companyId || b.brokerId !== identity.brokerId
      || b.agentId !== identity.agentId || b.runId !== identity.runId) return null;
    const now = await readAuthorityTime(tx, identity.companyId, clock);
    if (now === null || !await lockPublicationBroker(tx, identity, now.wallMs)) return null;
    const [row] = await tx.select().from(publicationRequests).where(predicate(b)).for("no key update");
    const decisionTime = await readAuthorityTime(tx, identity.companyId, clock);
    if (decisionTime === null) return null;
    const broker = await lockPublicationBroker(tx, identity, decisionTime.wallMs);
    return broker && row && isDeepStrictEqual(row.bindings, b)
      ? { row, now: decisionTime, brokerLifetimeMs: broker.validUntilMs - decisionTime.wallMs } : null;
  }

  return {
    async request(identity: PublicationIdentity, input: unknown, lifetimeMs = 30_000): Promise<PublicationDecision> {
      const b = publicationBindingsSchema.parse(input);
      if (!Number.isInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 30_000) return deny("invalid_lifetime");
      return db.transaction(async (tx) => {
        const invalid = await lockPublicationContext(tx, b, identity);
        if (invalid) return deny(invalid);
        const now = await readAuthorityTime(tx, identity.companyId, clock);
        if (now === null || !await lockPublicationBroker(tx, identity, now.wallMs)) return deny("authority_unavailable");
        // Never overwrite bindings or expiry on an idempotent replay.
        const [created] = await tx.insert(publicationRequests).values({
          id: b.requestId, companyId: b.companyId, brokerId: b.brokerId, issueId: b.issueId,
          agentId: b.agentId, runId: b.runId, repository: b.repository, branch: b.branch, bindings: b,
          issuedAtMs: now.wallMs, expiresAtMs: now.wallMs + lifetimeMs, issuedMonotonicMs: now.monotonicMs,
        }).onConflictDoNothing().returning();
        const [existing] = created ? [created] : await tx.select().from(publicationRequests).where(predicate(b));
        if (!existing || !isDeepStrictEqual(existing.bindings, b)) return deny("bindings_changed");
        if (created) await audit(tx, identity, b, "requested");
        return deny(created ? "recorded" : "replay", existing);
      });
    },

    async dispatch(identity: PublicationIdentity, input: unknown): Promise<PublicationDecision> {
      const b = publicationBindingsSchema.parse(input);
      return db.transaction(async (tx) => {
        const invalid = await lockPublicationContext(tx, b, identity);
        if (invalid) return deny(invalid);
        const locked = await lockRequest(tx, identity, b);
        if (!locked) return deny("authority_unavailable");
        const { row, now, brokerLifetimeMs } = locked;
        if (row.revokedAt || row.state !== "pending") return deny("replay_or_revoked", row);
        const remaining = Math.min(brokerLifetimeMs, row.expiresAtMs - now.wallMs,
          row.expiresAtMs - row.issuedAtMs - (now.monotonicMs - row.issuedMonotonicMs));
        if (remaining <= 0) return deny("expired", row);
        const [outstanding] = await tx.select({ id: publicationRequests.id }).from(publicationRequests).where(and(
          eq(publicationRequests.companyId, b.companyId), eq(publicationRequests.repository, b.repository),
          eq(publicationRequests.branch, b.branch), inArray(publicationRequests.state, ["dispatched", "unknown"]),
        ));
        if (outstanding) return deny("reconciliation_required", row);
        await tx.update(publicationRequests).set({ state: "dispatched", dispatchedAtMs: now.wallMs }).where(predicate(b));
        await audit(tx, identity, b, "dispatched");
        return { dispatch: true, state: "dispatched", reason: "authorized", remainingLifetimeMs: remaining };
      });
    },

    async revoke(identity: PublicationIdentity, input: unknown): Promise<PublicationDecision> {
      const b = publicationBindingsSchema.parse(input);
      return db.transaction(async (tx) => {
        const locked = await lockRequest(tx, identity, b);
        if (!locked) return deny("authority_unavailable");
        const { row, now } = locked;
        if (!row.revokedAt) {
          await tx.update(publicationRequests).set({
            revokedAt: new Date(now.wallMs), state: row.state === "pending" ? "revoked" : row.state,
          }).where(predicate(b));
          await audit(tx, identity, b, "revoked");
        }
        return deny("revoked", { ...row, state: row.state === "pending" ? "revoked" : row.state });
      });
    },

    async recordResult(identity: PublicationIdentity, input: unknown, result: Result): Promise<PublicationDecision> {
      const b = publicationBindingsSchema.parse(input);
      if (!["succeeded", "refused", "unknown"].includes(result)) return deny("invalid_result");
      return db.transaction(async (tx) => {
        const locked = await lockRequest(tx, identity, b);
        if (!locked) return deny("authority_unavailable");
        const { row } = locked;
        if (row.state !== "dispatched") return deny("replay", row);
        await tx.update(publicationRequests).set({ state: result }).where(predicate(b));
        await audit(tx, identity, b, `result_${result}`);
        return deny("result_recorded", { ...row, state: result });
      });
    },

  };
}
