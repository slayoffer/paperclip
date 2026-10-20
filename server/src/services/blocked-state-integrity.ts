import { and, desc, eq, gt, inArray, isNull, like, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issueComments, issues, issueThreadInteractions } from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";

export function blockedStateIntegrityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCLIP_BLOCKED_STATE_INTEGRITY === "true";
}

export function blockerIsResolved(status: string): boolean {
  return status === "done" || (blockedStateIntegrityEnabled() && status === "cancelled");
}

export function hasOutsideWait(descriptor: IssueUnblockDescriptor | null | undefined): boolean {
  if (!descriptor?.action.trim()) return false;
  if (descriptor.kind === "external" || descriptor.kind === "human") return true;
  return descriptor.kind === "date" && Boolean(descriptor.until && Date.parse(descriptor.until) > Date.now());
}

type WaitIssue = Pick<typeof issues.$inferSelect, "id" | "companyId" | "identifier" | "assigneeAgentId" | "unblockDescriptor">;

/** Read the current owner's most recent handoff. A comment never grants merge authority. */
export async function hasPendingHandoffWait(
  db: Pick<Db, "select">,
  issue: WaitIssue,
  descriptor: IssueUnblockDescriptor | null | undefined = issue.unblockDescriptor,
  commentBody?: string | null,
): Promise<boolean> {
  if (!blockedStateIntegrityEnabled() || !issue.assigneeAgentId || !descriptor) return false;
  if (descriptor.owner === "board" || !("agentId" in descriptor.owner) ||
      descriptor.owner.agentId !== issue.assigneeAgentId) return false;
  const handoff = commentBody?.includes("```handoff") ? { body: commentBody, createdAt: new Date() } :
    await db.select({ body: issueComments.body, createdAt: issueComments.createdAt })
      .from(issueComments).where(and(
        eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
        eq(issueComments.authorAgentId, issue.assigneeAgentId), isNull(issueComments.deletedAt),
        like(issueComments.body, "%```handoff%"),
      )).orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1).then(rows => rows[0]);
  if (!handoff) return false;
  const manifest = handoff.body.match(/^```handoff\r?\nrepo: [\w.-]+\/[\w.-]+\r?\nbase: [a-f0-9]{40}\r?\nhead: ([a-f0-9]{40})\r?\nbranch: ([^\r\n]+)\r?\n```/m);
  if (!manifest || manifest[2] !== `review/${issue.identifier}` || !descriptor.action.includes(manifest[1]!)) return false;
  const later = await db.select({ body: issueComments.body }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    gt(issueComments.createdAt, handoff.createdAt), isNull(issueComments.deletedAt),
  ));
  return !later.some(row => /^(?:Cross-vendor review r\d+ REJECTED|Merge go:|Self-merge accepted:)/.test(row.body));
}

export async function openBridgeHoldIds(db: Pick<Db, "select">, issue: Pick<WaitIssue, "id" | "companyId" | "identifier">) {
  if (!blockedStateIntegrityEnabled() || !issue.identifier) return [];
  return db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, issue.companyId), eq(issues.parentId, issue.id),
    eq(issues.title, `Review hold: ${issue.identifier} (bridge-owned, do not edit)`),
    notInArray(issues.status, ["done", "cancelled"]), isNull(issues.hiddenAt),
  )).then(rows => rows.map(row => row.id));
}

export async function blockedWaitFacts(
  db: Pick<Db, "select">,
  issue: WaitIssue,
  descriptor: IssueUnblockDescriptor | null | undefined,
  requestedBlockerIds?: string[],
  commentBody?: string | null,
) {
  // Readiness also includes terminal blockers whose workspace finalization is unfinished.
  const { getRequestedBlockerDependencyReadiness, listIssueDependencyReadinessMap } =
    await import("./issue-dependency-readiness.js");
  const readiness = requestedBlockerIds !== undefined
    ? await getRequestedBlockerDependencyReadiness(db, issue.companyId, issue.id, requestedBlockerIds)
    : (await listIssueDependencyReadinessMap(db, issue.companyId, [issue.id])).get(issue.id)!;
  const blockers = readiness.unresolvedBlockerIssueIds.length === 0 ? [] :
    await db.select({ identifier: issues.identifier }).from(issues).where(and(
      eq(issues.companyId, issue.companyId), inArray(issues.id, readiness.unresolvedBlockerIssueIds),
    ));
  const [interaction, approval, review, holds] = await Promise.all([
    db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id),
      eq(issueThreadInteractions.status, "pending"),
    )).limit(1),
    db.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId)).where(and(
      eq(issueApprovals.companyId, issue.companyId), eq(approvals.companyId, issue.companyId),
      eq(issueApprovals.issueId, issue.id), inArray(approvals.status, ["pending", "revision_requested"]),
    )).limit(1),
    hasPendingHandoffWait(db, issue, descriptor, commentBody),
    openBridgeHoldIds(db, issue),
  ]);
  const linkedIdentifiers = new Set(blockers.map(row => row.identifier));
  const mentions = descriptor?.action.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? [];
  return {
    hasTarget: blockers.length > 0 || interaction.length > 0 || approval.length > 0 || review || holds.length > 0,
    outside: hasOutsideWait(descriptor),
    unlinkedReferences: mentions.filter(identifier => !linkedIdentifiers.has(identifier) && identifier !== issue.identifier),
  };
}

export async function hasNonDependencyBlockedWait(db: Pick<Db, "select">, issueId: string) {
  if (!blockedStateIntegrityEnabled()) return false;
  const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then(rows => rows[0]);
  if (!issue || issue.status !== "blocked") return false;
  const facts = await blockedWaitFacts(db, issue, issue.unblockDescriptor, []);
  return facts.hasTarget || facts.outside;
}

export async function assertRealBlockedWait(db: Pick<Db, "select">, issue: WaitIssue & { status: string }, commentBody?: string | null) {
  if (!blockedStateIntegrityEnabled() || issue.status !== "blocked") return;
  const facts = await blockedWaitFacts(db, issue, issue.unblockDescriptor, undefined, commentBody);
  const { unprocessable } = await import("../errors.js");
  if (facts.unlinkedReferences.length) {
    throw unprocessable("The blocked action names an issue without an open blocker link", { issueIdentifiers: facts.unlinkedReferences });
  }
  if (!facts.hasTarget && !facts.outside) {
    throw unprocessable("Blocked status requires an open blocker, a pending review or card, or a typed outside wait");
  }
}
