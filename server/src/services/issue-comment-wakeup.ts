/**
 * Info-only comment marker (synthiq fork, 2026-10-16). A comment whose body starts with `[no-wake]` (case-insensitive,
 * leading whitespace allowed) is recorded and shown normally, but it does not wake the assignee and does not
 * implicitly reopen a blocked or closed issue. An explicit `resume: true` or `reopen: true` on the same request still
 * wins. Without the marker nothing changes. Use it for status notes that need no action; a comment that carries a
 * decision the assignee must act on must not carry it.
 */
export const NO_WAKE_COMMENT_MARKER = "[no-wake]";

/**
 * Wake-marker rule (synthiq fork, Guild model v2 rule 3, 2026-10-17). When PAPERCLIP_COMMENT_WAKE_REQUIRES_MARKER is
 * "true", a comment from an agent, a board API key or any other non-browser actor wakes the assignee only if its body
 * starts with `[wake]` or has `[wake]` as a whole line.
 * Human board comments (browser session) keep waking, and events (cards, blockers, monitors, assignment) are not
 * comments, so they are unaffected. Off by default: an operator switch, read on every request.
 */
export const WAKE_COMMENT_MARKER = "[wake]";

/** `[wake]` at the start of the body, or as a whole line anywhere (the review bridge puts it on the last line). */
export function isWakeComment(body: unknown): boolean {
  if (typeof body !== "string") return false;
  if (body.trimStart().toLowerCase().startsWith(WAKE_COMMENT_MARKER)) return true;
  return body.split(/\r?\n/).some((line) => line.trim().toLowerCase() === WAKE_COMMENT_MARKER);
}

export function commentWakeRequiresMarker(actor: { type?: string; source?: string } | undefined | null): boolean {
  if (process.env.PAPERCLIP_COMMENT_WAKE_REQUIRES_MARKER !== "true" || !actor) return false;
  // Only a person typing in the board UI (browser session, or local implicit mode) is exempt.
  return !(actor.type === "board" && (actor.source === "session" || actor.source === "local_implicit"));
}

/** True when a comment must not wake (or implicitly reopen): an explicit [no-wake], or a missing [wake] under the rule. */
export function commentWakeSuppressed(body: unknown, actor: { type?: string; source?: string } | undefined | null): boolean {
  if (isNoWakeComment(body)) return true;
  return commentWakeRequiresMarker(actor) && !isWakeComment(body);
}

export function isNoWakeComment(body: unknown): boolean {
  return typeof body === "string" && body.trimStart().toLowerCase().startsWith(NO_WAKE_COMMENT_MARKER);
}

export function shouldWakeAssigneeForIssueComment(input: {
  selfComment: boolean;
  resumeRequested: boolean;
  commentCreatedByRunId?: string | null;
  issueAtCommentStart: {
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  };
  reopened: boolean;
  currentStatus: string | null | undefined;
  noWake?: boolean;
}) {
  if (input.noWake && !input.resumeRequested && !input.reopened) return false;
  const sourceRunId = input.commentCreatedByRunId;
  const commentIsFromCurrentIssueRun = Boolean(
    sourceRunId &&
    (sourceRunId === input.issueAtCommentStart.checkoutRunId ||
      sourceRunId === input.issueAtCommentStart.executionRunId),
  );
  if (
    input.selfComment &&
    (!input.resumeRequested || commentIsFromCurrentIssueRun)
  ) {
    return false;
  }
  return (
    input.reopened ||
    (input.currentStatus !== "done" && input.currentStatus !== "cancelled")
  );
}
