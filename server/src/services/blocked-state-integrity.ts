import { and, desc, eq, gt, inArray, isNull, like, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issueComments, issues, issueThreadInteractions } from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { isReviewBridgeWait } from "./review-bridge-contract.js";
import { isPullQueueEnabled } from "./pull-queue-policy.js";
import { hasSavedReviewWait, parseReviewHandoffManifest } from "./review-wait.js";

// Known defect with integrity enabled: duplicate parent wake (r18 P1), tracked in SYNA-2572.
// Keep this flag OFF until SYNA-2572 merges.
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

const ISSUE_REFERENCE = /\b[A-Z][A-Z0-9]*-\d+\b/g;
/** Words that only frame issue references, for example "Wait for SYNA-1780 and SYNA-1781 to finish". */
const ISSUE_REFERENCE_FRAME = new Set(["wait", "waits", "waiting", "for", "on", "until", "after", "blocked", "blocker",
  "blockers", "by", "issue", "issues", "task", "tasks", "and", "or", "the", "to", "be", "is", "are", "of", "complete",
  "completed", "completion", "finish", "finishes", "finished", "done", "resolve", "resolved", "close", "closed"]);

export function issueReferences(action: string | null | undefined): string[] {
  return action?.match(ISSUE_REFERENCE) ?? [];
}

/** True when the action names issues and no other wait. */
export function namesOnlyIssueReferences(action: string): boolean {
  if (!issueReferences(action).length) return false;
  return action.replace(ISSUE_REFERENCE, " ").toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .every(word => !word || ISSUE_REFERENCE_FRAME.has(word));
}

/**
 * A typed wait whose action names only other issues is stale when all of them are complete.
 * Cancelled issues count as complete under the same rules as dependency readiness.
 */
async function isStaleIssueOnlyWait(db: Pick<Db, "select">, issue: WaitIssue, descriptor: IssueUnblockDescriptor) {
  if (descriptor.kind === "date" || !namesOnlyIssueReferences(descriptor.action)) return false;
  const references = [...new Set(issueReferences(descriptor.action))].filter(identifier => identifier !== issue.identifier);
  if (!references.length) return false;
  const rows = await db.select({ status: issues.status }).from(issues).where(and(
    eq(issues.companyId, issue.companyId), inArray(issues.identifier, references),
  ));
  return rows.length === references.length &&
    rows.every(row => blockerIsResolved(row.status) || (isPullQueueEnabled() && row.status === "cancelled"));
}

type WaitIssue = Pick<typeof issues.$inferSelect, "id" | "companyId" | "identifier" | "assigneeAgentId" | "unblockDescriptor">;

/** Read the current owner's most recent handoff. A comment never grants merge authority. */
export async function hasPendingHandoffWait(
  db: Pick<Db, "select">,
  issue: WaitIssue,
  descriptor: IssueUnblockDescriptor | null | undefined = issue.unblockDescriptor,
  commentBody?: string | null,
): Promise<boolean> {
  if (isReviewBridgeWait(descriptor)) return true;
  if (!blockedStateIntegrityEnabled() || !issue.assigneeAgentId || !descriptor) return false;
  if (descriptor.owner === "board") {
    if (!await hasSavedReviewWait(db, issue, issue.assigneeAgentId, descriptor)) return false;
    commentBody = null;
  } else if (!("agentId" in descriptor.owner) || descriptor.owner.agentId !== issue.assigneeAgentId) return false;
  const handoff = commentBody?.includes("```handoff") ? { body: commentBody, createdAt: new Date() } :
    await db.select({ body: issueComments.body, createdAt: issueComments.createdAt })
      .from(issueComments).where(and(
        eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
        eq(issueComments.authorAgentId, issue.assigneeAgentId), isNull(issueComments.deletedAt),
        like(issueComments.body, "%```handoff%"),
      )).orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1).then(rows => rows[0]);
  if (!handoff) return false;
  const manifest = parseReviewHandoffManifest(handoff.body);
  if (!manifest || manifest.branch !== `review/${issue.identifier}` || !descriptor.action.toLowerCase().includes(manifest.head)) return false;
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
  const holds = await openBridgeHoldIds(db, issue);
  // Blocker synchronization retains these holds when it replaces the requested links.
  const effectiveBlockerIds = requestedBlockerIds === undefined ? undefined :
    [...new Set([...requestedBlockerIds, ...holds])];
  const readiness = effectiveBlockerIds !== undefined
    ? await getRequestedBlockerDependencyReadiness(db, issue.companyId, issue.id, effectiveBlockerIds)
    : (await listIssueDependencyReadinessMap(db, issue.companyId, [issue.id])).get(issue.id)!;
  // Reference membership includes resolved links. Only unresolved links affect readiness.
  const blockers = readiness.blockerIssueIds.length === 0 ? [] :
    await db.select({ identifier: issues.identifier }).from(issues).where(and(
      eq(issues.companyId, issue.companyId), inArray(issues.id, readiness.blockerIssueIds),
    ));
  const [interaction, approval, review] = await Promise.all([
    db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id),
      eq(issueThreadInteractions.status, "pending"),
    )).limit(1),
    db.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId)).where(and(
      eq(issueApprovals.companyId, issue.companyId), eq(approvals.companyId, issue.companyId),
      eq(issueApprovals.issueId, issue.id), inArray(approvals.status, ["pending", "revision_requested"]),
    )).limit(1),
    hasPendingHandoffWait(db, issue, descriptor, commentBody),
  ]);
  const linkedIdentifiers = new Set(blockers.map(row => row.identifier));
  const mentions = issueReferences(descriptor?.action);
  return {
    hasTarget: readiness.unresolvedBlockerCount > 0 || interaction.length > 0 || approval.length > 0 || review || holds.length > 0,
    outside: hasOutsideWait(descriptor) && !await isStaleIssueOnlyWait(db, issue, descriptor!),
    unlinkedReferences: mentions.filter(identifier => !linkedIdentifiers.has(identifier) && identifier !== issue.identifier),
  };
}

export async function hasNonDependencyBlockedWait(db: Pick<Db, "select">, issueId: string) {
  const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then(rows => rows[0]);
  if (!issue || issue.status !== "blocked") return false;
  if (isReviewBridgeWait(issue.unblockDescriptor)) return true;
  if (!blockedStateIntegrityEnabled()) return false;
  const facts = await blockedWaitFacts(db, issue, issue.unblockDescriptor, []);
  return facts.hasTarget || facts.outside;
}

export async function assertRealBlockedWait(db: Pick<Db, "select">, issue: WaitIssue & { status: string }, commentBody?: string | null) {
  if (!blockedStateIntegrityEnabled() || issue.status !== "blocked") return;
  const facts = await blockedWaitFacts(db, issue, issue.unblockDescriptor, undefined, commentBody);
  const { unprocessable } = await import("../errors.js");
  if (facts.unlinkedReferences.length) {
    throw unprocessable("The blocked action names an issue without a blocker link", { issueIdentifiers: facts.unlinkedReferences });
  }
  if (!facts.hasTarget && !facts.outside) {
    throw unprocessable("Blocked status requires an open blocker, a pending review or card, or a typed outside wait");
  }
}
