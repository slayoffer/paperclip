import { and, asc, eq, notInArray, isNull } from "drizzle-orm";
import { agentWakeupRequests, interactionResolutionOutbox, issueThreadInteractions, type Db } from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { logger } from "../middleware/logger.js";
import { readObject, readSecretProposalContinuationContext } from "../routes/interaction-continuation-context.js";

type Wakes = typeof interactionResolutionOutbox.$inferInsert.wakes;

/** Capture intents in the answer transaction. Do not dispatch before its commit. */
export async function persistInteractionResolutionWakes(
  db: Db,
  interaction: IssueThreadInteraction,
  collect: (heartbeat: IssueAssignmentWakeupDeps) => Promise<void>,
) {
  const wakes: Wakes = [];
  await collect({ wakeup: async (agentId, options) => {
    wakes.push({ agentId, options: {
      ...options,
      // All deliveries use the existing durable interaction deduplication namespace.
      idempotencyKey: options.idempotencyKey ?? `interaction:${interaction.id}:assignment:${options.payload?.issueId}`,
    } });
  } });
  if (wakes.length) await db.insert(interactionResolutionOutbox).values({
    interactionId: interaction.id, companyId: interaction.companyId, issueId: interaction.issueId, wakes,
  });
}

export function interactionResolutionOutboxService(db: Db, heartbeat: IssueAssignmentWakeupDeps) {
  async function deliver(interactionId: string) {
    const [entry] = await db.select().from(interactionResolutionOutbox)
      .where(and(eq(interactionResolutionOutbox.interactionId, interactionId), isNull(interactionResolutionOutbox.deliveredAt)));
    if (!entry) return;
    const [interaction] = await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.id, entry.interactionId), eq(issueThreadInteractions.companyId, entry.companyId),
      eq(issueThreadInteractions.issueId, entry.issueId),
    ));
    if (!interaction) return;
    // A binding decision and its execution are separate operations. Preserve
    // the route's execution-before-continuation order for these confirmations.
    const secretProposal = readSecretProposalContinuationContext(interaction);
    if (interaction.status === "accepted" && readObject(interaction.payload).secretProposal && !secretProposal) return;
    for (const wake of entry.wakes) {
      const key = wake.options.idempotencyKey as string;
      const options = secretProposal ? { ...wake.options,
        payload: { ...readObject(wake.options.payload), secretProposal },
        contextSnapshot: { ...readObject(wake.options.contextSnapshot), secretProposal },
      } : wake.options;
      // A crash after admission can leave this outbox pending. The wake receipt
      // is authoritative. The queue's unique index also protects concurrent workers.
      const existing = () => db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, entry.companyId), eq(agentWakeupRequests.agentId, wake.agentId),
        eq(agentWakeupRequests.idempotencyKey, key),
        notInArray(agentWakeupRequests.status, ["skipped", "failed", "cancelled"]),
      )).limit(1);
      if (!(await existing()).length) {
        try {
          await heartbeat.wakeup(wake.agentId, options as Parameters<IssueAssignmentWakeupDeps["wakeup"]>[1]);
        } catch (error) {
          if (!(await existing()).length) throw error;
        }
        // A null return can mean suppressed admission. Keep the intent pending
        // unless the queue actually saved a durable receipt.
        if (!(await existing()).length) return;
      }
    }
    await db.update(interactionResolutionOutbox).set({ deliveredAt: new Date() })
      .where(and(eq(interactionResolutionOutbox.interactionId, interactionId), isNull(interactionResolutionOutbox.deliveredAt)));
  }

  async function sweepPending(limit = 50) {
    const entries = await db.select({ interactionId: interactionResolutionOutbox.interactionId })
      .from(interactionResolutionOutbox).where(isNull(interactionResolutionOutbox.deliveredAt))
      .orderBy(asc(interactionResolutionOutbox.createdAt)).limit(limit);
    for (const entry of entries) await deliver(entry.interactionId).catch((err) => {
      logger.warn({ err, interactionId: entry.interactionId }, "interaction continuation delivery remains pending");
    });
  }
  return { deliver, sweepPending };
}
