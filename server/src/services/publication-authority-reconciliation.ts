import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { activityLog, publicationRequests, type Db } from "@paperclipai/db";
import { publicationBindingsSchema, type PublicationBindings, type PublicationDecision } from "@paperclipai/shared";
import type { PublicationTransaction } from "./publication-authority-context.js";

type Request = typeof publicationRequests.$inferSelect;
type Proof = { result: "succeeded" | "refused" | "unknown"; evidenceId: string };
const deny = (reason: string, row?: Request): PublicationDecision => ({
  dispatch: false, state: row?.state ?? "denied", reason, remainingLifetimeMs: 0,
});

/** Protected offline capability. Never construct this service from broker input or expose it through broker routes. */
export function publicationReconciliationService(db: Db, authority: {
  companyId: string;
  verifierId: string;
  verify?: (bindings: PublicationBindings) => Promise<Proof>;
}) {
  // Capture the protected configuration. Later caller mutations cannot replace its scope or verifier.
  const { companyId, verifierId, verify } = authority;
  const predicate = (b: PublicationBindings) => and(
    eq(publicationRequests.companyId, companyId), eq(publicationRequests.id, b.requestId),
  );
  async function lockRequest(tx: PublicationTransaction, b: PublicationBindings) {
    if (b.companyId !== companyId) return null;
    const [row] = await tx.select().from(publicationRequests).where(predicate(b)).for("no key update");
    return row && isDeepStrictEqual(row.bindings, b) ? row : null;
  }

  return {
    async reconcile(input: unknown): Promise<PublicationDecision> {
      const b = publicationBindingsSchema.parse(input);
      if (!verify) return deny("verifier_unavailable");
      const row = await db.transaction((tx) => lockRequest(tx, b));
      if (!row) return deny("authority_unavailable");
      if (!["unknown", "dispatched"].includes(row.state)) return deny("replay", row);
      // Observation uses the stored bindings outside locks. Neither broker validity nor dispatch time grants this capability.
      const proof = await verify(row.bindings);
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(proof.evidenceId)
        || !["succeeded", "refused"].includes(proof.result)) return deny("result_uncertain", row);
      return db.transaction(async (tx) => {
        // Recheck scope, all bindings, and state after the observation. Serialize competing reconciliation and result writers.
        const current = await lockRequest(tx, b);
        if (!current) return deny("authority_unavailable");
        if (!["unknown", "dispatched"].includes(current.state)) return deny("replay", current);
        await tx.update(publicationRequests).set({ state: proof.result, reconciliationId: proof.evidenceId }).where(predicate(b));
        await tx.insert(activityLog).values({
          companyId, actorType: "system", actorId: verifierId,
          agentId: current.agentId, runId: current.runId,
          action: "publication.reconciled", entityType: "publication_request", entityId: current.id,
          details: { issueId: current.issueId, reconciliationId: proof.evidenceId },
        });
        return deny("reconciled", { ...current, state: proof.result });
      });
    },
  };
}
