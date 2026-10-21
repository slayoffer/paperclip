import { and, eq } from "drizzle-orm";
import { companySecretProposals, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { conflict, forbidden, HttpError } from "../errors.js";
import { readObject, readSecretProposalContinuationContext } from "../routes/interaction-continuation-context.js";
import { assertCanResolveProposal } from "./secret-proposal-authorization.js";
import { createSecretProposalsService } from "./secret-proposals.js";
import type { AuthorizationActor } from "./authorization.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";

/** The accepted interaction and its outbox row are the durable execution intent.
 * Resume under issue -> proposal locks. Approval saves the binding and execution
 * result in one transaction. Parallel retries cannot apply the binding twice. */
export async function resumeAcceptedBinding(db: Db, intent: {
  companyId: string; issueId: string; interactionId: string;
  authorizationContext?: Record<string, unknown> | null;
}) {
  let bindingId: string | undefined;
  try {
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const [source] = await tx.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.id, intent.interactionId), eq(issueThreadInteractions.companyId, intent.companyId),
        eq(issueThreadInteractions.issueId, intent.issueId)));
      const linked = readObject(readObject(source?.payload).secretProposal);
      if (!source || source.status !== "accepted" || source.kind !== "request_confirmation" || !linked.proposalId) return;
      if (readSecretProposalContinuationContext(source)) return;
      const [issue] = await tx.select().from(issues).where(and(
        eq(issues.id, intent.issueId), eq(issues.companyId, intent.companyId))).for("update");
      if (!issue || issue.status === "done" || issue.status === "cancelled") {
        throw conflict("Binding execution requires an open issue");
      }
      bindingId = typeof linked.proposalId === "string" ? linked.proposalId : undefined;
      if (!bindingId) throw conflict("Binding proposal identifier is invalid");
      const proposals = createSecretProposalsService(tx);
      const proposal = await proposals.getById(intent.companyId, bindingId, tx, true);
      const [interaction] = await tx.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.id, intent.interactionId), eq(issueThreadInteractions.companyId, intent.companyId),
        eq(issueThreadInteractions.issueId, intent.issueId)));
      if (!interaction || interaction.status !== "accepted") throw conflict("Binding acceptance is no longer current");
      // Re-read after locks. A concurrent worker can finish while this worker waits.
      if (readSecretProposalContinuationContext(interaction)) return;
      const payload = readObject(readObject(interaction.payload).secretProposal);
      if (!proposal || proposal.kind !== "binding" || proposal.originIssueId !== issue.id ||
          proposal.interactionId !== interaction.id || payload.proposalId !== proposal.id ||
          payload.configPath !== proposal.configPath || payload.targetAgentId !== proposal.targetId) {
        throw conflict("Binding proposal does not match its accepted interaction");
      }
      const userId = interaction.resolvedByUserId;
      if (!userId || interaction.resolvedByAgentId) throw forbidden("Binding execution requires its board user");
      // Old intents without authenticated context must fail closed. Never infer
      // a session source from the resolving user's identity.
      const actor = intent.authorizationContext as AuthorizationActor | null | undefined;
      if (actor?.type !== "board" || actor.userId !== userId || !actor.source ||
          !["local_implicit", "session", "board_key", "mcp_oauth", "cloud_tenant", "cloud_control"].includes(actor.source)) {
        throw forbidden("Binding execution requires its original authorization context");
      }
      await proposals.approve(intent.companyId, proposal.id, {
        resolvedByUserId: userId,
        assertCanResolve: (lockedProposal, txDb) => assertCanResolveProposal({
          db: txDb, companyId: intent.companyId, proposal: lockedProposal,
          actor,
        }),
      });
    });
  } catch (error) {
    // Database and process failures leave the intent pending. A later retry can
    // finish it. A checked policy or lifecycle failure is a terminal result.
    if (!(error instanceof HttpError) || ![400, 403, 404, 409, 422].includes(error.status) || !bindingId) throw error;
    await issueThreadInteractionService(db).recordSecretProposalExecutionResult(
      { id: intent.issueId, companyId: intent.companyId }, intent.interactionId, bindingId,
      { status: "failed", errorCode: `http_${error.status}` },
    );
  }
}
