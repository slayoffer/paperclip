import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { companySecretProposals, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { issueThreadInteractionResolutionError } from "./issue-thread-interaction-resolution.js";

type Row = typeof issueThreadInteractions.$inferSelect;
type Actor = { agentId?: string | null; userId?: string | null; systemId?: string | null };
export type InteractionAnswerPreconditions = { expectedRevision?: string; idempotencyKey?: string };
const protectedTransactions = new WeakSet<object>();
const replays = new WeakSet<object>();
export const markInteractionResolutionReplay = (value: object) => replays.add(value);
export const isInteractionResolutionReplay = (interaction: object) => replays.has(interaction);
export const isInteractionRevisionTransaction = (db: object) => protectedTransactions.has(db);
export const needsInteractionRevisionLock = (db: Db, input: InteractionAnswerPreconditions) =>
  !protectedTransactions.has(db) && (input.expectedRevision !== undefined || input.idempotencyKey !== undefined);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

export function interactionAnswerReceipt(operation: string, input: InteractionAnswerPreconditions, actor: Actor) {
  if (!input.idempotencyKey) return null;
  return { key: input.idempotencyKey, fingerprint: createHash("sha256").update(JSON.stringify(canonical({
    operation, input, actor: { agentId: actor.agentId ?? null, userId: actor.userId ?? null, systemId: actor.systemId ?? null },
  }))).digest("hex") };
}

export function checkInteractionAnswerPreconditions(row: Row, input: InteractionAnswerPreconditions,
  receipt: ReturnType<typeof interactionAnswerReceipt>): boolean {
  if (receipt && row.resolutionRequest?.key === receipt.key) {
    if (row.resolutionRequest.fingerprint !== receipt.fingerprint) throw issueThreadInteractionResolutionError(
      409, "interaction_idempotency_conflict", "This answer key identifies a different request");
    return true;
  }
  // Terminal lifecycle errors retain their existing codes in the service.
  if (row.status === "pending" && input.expectedRevision !== undefined && row.revision !== input.expectedRevision) {
    throw issueThreadInteractionResolutionError(409, "interaction_revision_conflict", "The interaction changed. Read it again before answering");
  }
  return false;
}

/** Preserve issue -> run -> proposal -> interaction ordering. The database trigger covers every writer. */
export async function resolveWithInteractionRevision<T>(args: {
  db: Db; issue: { id: string; companyId: string }; interactionId: string;
  input: InteractionAnswerPreconditions; operation: string; actor: Actor;
  beforeLock: (tx: Db) => Promise<void>;
  authorize: (row: Row) => void;
  hydrate: (row: Row) => IssueThreadInteraction;
  replay: (interaction: IssueThreadInteraction) => T;
  resolve: (tx: Db, issue: typeof issues.$inferSelect) => Promise<T>;
  interaction: (result: T) => IssueThreadInteraction;
}): Promise<T> {
  return args.db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, args.issue.id),
      eq(issues.companyId, args.issue.companyId))).for("update");
    if (!issue) throw issueThreadInteractionResolutionError(404, "interaction_not_found", "Interaction not found");
    await args.beforeLock(tx);
    const [source] = await tx.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.id, args.interactionId), eq(issueThreadInteractions.issueId, issue.id),
      eq(issueThreadInteractions.companyId, issue.companyId)));
    if (!source) throw issueThreadInteractionResolutionError(404, "interaction_not_found", "Interaction not found");
    const proposal = (source.payload as { secretProposal?: { proposalId?: string } }).secretProposal?.proposalId;
    if (proposal) await tx.select({ id: companySecretProposals.id }).from(companySecretProposals).where(and(
      eq(companySecretProposals.id, proposal), eq(companySecretProposals.companyId, issue.companyId),
      eq(companySecretProposals.interactionId, source.id))).for("update");
    const [row] = await tx.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, source.id)).for("update");
    if (!row || row.companyId !== issue.companyId || row.issueId !== issue.id) {
      throw issueThreadInteractionResolutionError(404, "interaction_not_found", "Interaction not found");
    }
    args.authorize(row);
    const receipt = interactionAnswerReceipt(args.operation, args.input, args.actor);
    if (checkInteractionAnswerPreconditions(row, { ...args.input, expectedRevision: args.input.expectedRevision ?? source.revision }, receipt)) {
      const interaction = args.hydrate(row);
      replays.add(interaction);
      return args.replay(interaction);
    }
    protectedTransactions.add(tx);
    try {
      const result = await args.resolve(tx, issue);
      if (receipt) {
        const [saved] = await tx.update(issueThreadInteractions).set({ resolutionRequest: receipt })
          .where(eq(issueThreadInteractions.id, row.id)).returning();
        Object.assign(args.interaction(result), args.hydrate(saved));
      }
      return result;
    } finally {
      protectedTransactions.delete(tx);
    }
  });
}
