export function isClosedIssueStatus(
  status: string | null | undefined,
): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

export function shouldImplicitlyMoveCommentedIssueToTodo(input: {
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
  actorId: string;
  actorRunId: string | null | undefined;
  checkoutRunId: string | null | undefined;
  executionRunId: string | null | undefined;
  requestAddsExplicitBlockers?: boolean;
}) {
  // A request that wires a non-empty blockedByIssueIds list is declaring that
  // the issue is waiting on other work. The implicit reopen exists for plain
  // conversational comments ("please continue"), not structured dependency
  // edits — flipping to todo here would contradict the caller's stated intent
  // in the same request.
  if (input.requestAddsExplicitBlockers) return false;
  // Local-CLI agents post comments under user auth, so the actor.type is "user"
  // even though the comment originates from the same heartbeat run that owns
  // the issue lock. Without this guard, an agent that closes its own issue and
  // then posts a follow-up comment in the same run silently reopens it.
  // Suppress the implicit move whenever the comment's source run matches the
  // issue's checkout/execution run.
  if (
    typeof input.actorRunId === "string" &&
    input.actorRunId.length > 0 &&
    (input.actorRunId === input.checkoutRunId ||
      input.actorRunId === input.executionRunId)
  ) {
    return false;
  }
  // Only human comments should implicitly reopen finished work.
  // Agent-authored comments remain communicative unless reopen was explicit.
  if (input.actorType !== "user") return false;
  if (
    !isClosedIssueStatus(input.issueStatus) &&
    input.issueStatus !== "blocked"
  )
    return false;
  if (
    typeof input.assigneeAgentId !== "string" ||
    input.assigneeAgentId.length === 0
  )
    return false;
  return true;
}

export function shouldHumanCommentResumeInProgressScheduledRetry(input: {
  hasComment: boolean;
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
}) {
  if (!input.hasComment) return false;
  if (input.actorType !== "user") return false;
  if (input.issueStatus !== "in_progress") return false;
  return (
    typeof input.assigneeAgentId === "string" &&
    input.assigneeAgentId.length > 0
  );
}

export function isExplicitResumeCapableStatus(status: string | null | undefined) {
  return (
    status === "done" ||
    status === "cancelled" ||
    status === "blocked" ||
    status === "todo" ||
    status === "in_progress"
  );
}

// Log-class comment from the assignee agent on a terminal (done/cancelled)
// issue is not a reopen signal. When the caller did not pass `resume: true`,
// this forces the reopen path off even if `reopen: true` was sent.
export function isAssigneeSelfCommentOnTerminalIssue(input: {
  hasCommentBody: boolean;
  resumeRequested: boolean;
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
  actorId: string;
}) {
  if (!input.hasCommentBody) return false;
  if (input.resumeRequested) return false;
  if (!isClosedIssueStatus(input.issueStatus)) return false;
  if (
    typeof input.assigneeAgentId !== "string" ||
    input.assigneeAgentId.length === 0
  )
    return false;
  if (input.actorType !== "agent") return false;
  return input.actorId === input.assigneeAgentId;
}
