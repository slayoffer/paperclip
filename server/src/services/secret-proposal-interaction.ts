import { and, eq, inArray } from "drizzle-orm";
import { companySecretProposals, issueThreadInteractions, type Db } from "@paperclipai/db";
import type { ResolutionVia } from "@paperclipai/shared";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Synchronize a linked card without changing provenance after its first resolution. */
export async function reflectProposalLifecycleOnInteraction(
  txDb: Db,
  proposal: typeof companySecretProposals.$inferSelect,
  outcome: "approved" | "rejected" | "withdrawn" | "expired",
  input: { via: ResolutionVia | null; resolvedByUserId?: string | null; reason?: string | null },
) {
  if (!proposal.interactionId) return;
  const current = await txDb.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, proposal.interactionId),
    eq(issueThreadInteractions.companyId, proposal.companyId),
  )).for("update").then((rows) => rows[0] ?? null);
  if (!current || (current.status !== "pending" && !(outcome === "approved" && current.status === "accepted"))) return;
  const linked = asRecord(asRecord(current.payload).secretProposal);
  if (linked.proposalId !== proposal.id) return;

  const now = new Date();
  const status = outcome === "approved" ? "accepted"
    : outcome === "rejected" ? "rejected" : outcome === "withdrawn" ? "cancelled" : "expired";
  const resultOutcome = outcome === "approved" ? "accepted" : outcome === "rejected" ? "rejected" : "withdrawn";
  await txDb.update(issueThreadInteractions).set({
    status,
    result: {
      ...asRecord(current.result),
      version: 1,
      outcome: resultOutcome,
      ...(input.reason ? { reason: input.reason } : {}),
      secretProposal: {
        version: 1,
        status: outcome === "approved" ? "executed" : outcome,
        updatedAt: now.toISOString(),
      },
    },
    resolvedByUserId: input.resolvedByUserId ?? current.resolvedByUserId ?? null,
    ...(current.resolvedAt === null ? input.via ?? { resolvedVia: null, resolvedViaKeyId: null } : {}),
    resolvedAt: current.resolvedAt ?? now,
    updatedAt: now,
  }).where(and(
    eq(issueThreadInteractions.id, current.id),
    inArray(issueThreadInteractions.status, outcome === "approved" ? ["pending", "accepted"] : ["pending"]),
  ));
}
