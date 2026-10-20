import type { Db } from "@paperclipai/db";
import type { heartbeatService } from "../services/heartbeat.js";
import { logger } from "../middleware/logger.js";
import { buildIssueBlockersResolvedWakeStateKey, findExistingIssueBlockersResolvedWakeForReadyState,
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON } from "../services/issue-dependency-wakeups.js";

type Wakeup = NonNullable<Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1]>;
type DependencyWakeInput = {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
  blockerIssueIds: string[];
  blockedTransitionAt?: Date | string | null;
  source: string;
  mutation: string;
};

/** Build the same dependency wake for update and comment completion paths. */
export async function createDependencyResolvedWakeup(db: Db, companyId: string,
  actor: { actorType: "user" | "agent" | "system"; actorId: string }, input: DependencyWakeInput,
  release?: () => Promise<boolean>,
): Promise<Wakeup | null> {
  if (release && !(await release())) return null;
  let idempotencyKey = buildIssueBlockersResolvedWakeStateKey(input);
  try {
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(db, { companyId, ...input });
    if (existing && existing.status !== "completed") return null;
    if (existing) idempotencyKey += ":release";
  } catch (err) {
    logger.warn({ err, issueId: input.dependentIssueId, idempotencyKey }, "failed to check an existing dependency wake");
  }
  return {
    source: "automation", triggerDetail: "system", reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    payload: { issueId: input.dependentIssueId, resolvedBlockerIssueId: input.resolvedBlockerIssueId,
      blockerIssueIds: input.blockerIssueIds, mutation: input.mutation },
    idempotencyKey, requestedByActorType: actor.actorType, requestedByActorId: actor.actorId,
    contextSnapshot: { issueId: input.dependentIssueId, taskId: input.dependentIssueId,
      wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON, source: input.source,
      resolvedBlockerIssueId: input.resolvedBlockerIssueId, blockerIssueIds: input.blockerIssueIds },
  };
}
