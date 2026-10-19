import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companyMemberships, issueApprovals, issues as issueRows, issueThreadInteractions } from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { SELF_BLOCK_REFUSAL, selfBlockGuardEnabled } from "./self-block-guard.js";
import { blockedStateIntegrityEnabled, blockedWaitFacts } from "./blocked-state-integrity.js";

export async function assertBlockedIssueUpdate(input: {
  db: Db;
  actor: Express.Request["actor"];
  existing: Pick<typeof issueRows.$inferSelect, "id" | "companyId" | "identifier" | "status" | "assigneeAgentId" | "unblockDescriptor">;
  updateFields: { status?: string; unblockDescriptor?: IssueUnblockDescriptor | null };
  requestedBlockerIds?: string[];
  getDependencyReadiness: (issueId: string) => Promise<{ unresolvedBlockerCount: number }>;
  commentBody?: string | null;
}) {
  const { db, actor, existing, updateFields, requestedBlockerIds, getDependencyReadiness, commentBody } = input;
  const integrity = blockedStateIntegrityEnabled();
  const nextStatus = updateFields.status ?? existing.status;
  if (updateFields.unblockDescriptor && nextStatus !== "blocked") {
    throw unprocessable("unblockDescriptor requires blocked status");
  }
  const descriptor = integrity && nextStatus === "blocked"
    ? updateFields.unblockDescriptor === undefined ? existing.unblockDescriptor : updateFields.unblockDescriptor
    : updateFields.unblockDescriptor ?? null;
  const facts = integrity && nextStatus === "blocked"
    ? await blockedWaitFacts(db, existing, descriptor, requestedBlockerIds, actor.type === "agent" && actor.agentId === existing.assigneeAgentId ? commentBody : null)
    : null;
  if (facts?.unlinkedReferences.length) {
    throw unprocessable("The blocked action names an issue without an open blocker link", { issueIdentifiers: facts.unlinkedReferences });
  }
  if (updateFields.unblockDescriptor && descriptor && typeof descriptor === "object") {
    const owner = descriptor.owner;
    if (
      actor.type === "agent" &&
      (owner === "board" || "userId" in owner)
    ) {
      throw forbidden(
        "Agents may only name themselves as an unblock owner",
      );
    }
    if (owner !== "board" && "agentId" in owner) {
      const target = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, owner.agentId),
            eq(agents.companyId, existing.companyId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!target)
        throw unprocessable(
          "Unblock owner agent must belong to the issue company",
        );
      if (
        actor.type === "agent" &&
        actor.agentId !== owner.agentId
      ) {
        throw forbidden(
          "Agents may only name themselves as an unblock owner",
        );
      }
      if (actor.type === "agent" && actor.agentId === owner.agentId && selfBlockGuardEnabled() && !(facts && (facts.hasTarget || facts.outside))) {
        throw conflict(SELF_BLOCK_REFUSAL, { code: "self_block_refused" });
      }
    } else if (owner !== "board" && "userId" in owner) {
      const member = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, existing.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, owner.userId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!member)
        throw unprocessable(
          "Unblock owner user must be an active company member",
        );
    }
  }
  const enteringBlocked =
    existing.status !== "blocked" && updateFields.status === "blocked";
  if (facts && !facts.hasTarget && !facts.outside) {
    throw unprocessable("Blocked status requires an open blocker, a pending review or card, or a typed outside wait");
  }
  if (enteringBlocked && !integrity) {
    const blockerIds = requestedBlockerIds ? [...new Set(requestedBlockerIds)] : null;
    const hasUnresolvedBlocker = blockerIds
      ? blockerIds.length > 0 &&
        (await db
          .select({ id: issueRows.id })
          .from(issueRows)
          .where(
            and(
              eq(issueRows.companyId, existing.companyId),
              inArray(issueRows.id, blockerIds),
              notInArray(issueRows.status, ["done", "cancelled"]),
            ),
          )
          .limit(1)
          .then((rows) => rows.length > 0))
      : (await getDependencyReadiness(existing.id))
          .unresolvedBlockerCount > 0;
    const [pendingInteraction, pendingApproval] = await Promise.all([
      db
        .select({ id: issueThreadInteractions.id })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, existing.companyId),
            eq(issueThreadInteractions.issueId, existing.id),
            eq(issueThreadInteractions.status, "pending"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: approvals.id })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(issueApprovals.companyId, existing.companyId),
            eq(issueApprovals.issueId, existing.id),
            eq(approvals.status, "pending"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    if (
      !hasUnresolvedBlocker &&
      !pendingInteraction &&
      !pendingApproval &&
      !descriptor
    ) {
      throw unprocessable("Entering blocked requires unresolved blockers, a pending interaction/approval, or unblockDescriptor");
    }
  }

}
