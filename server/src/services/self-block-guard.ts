/**
 * Self-block guard (synthiq fork, Anton 2026-10-17). Measured 2026-10-17 (14 h): 106 `issue_unblock_requested` runs,
 * 39% of Codex input tokens, all woke the issue's own assignee; in 74 the agent had named itself as unblock owner, up to
 * 15 times on one issue. With PAPERCLIP_SELF_BLOCK_GUARD=true:
 * - an agent cannot name itself as the unblock owner (409 with what to do instead), and
 * - no unblock-request wake is sent to an issue's own assignee.
 */
export function selfBlockGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCLIP_SELF_BLOCK_GUARD === "true";
}

export const SELF_BLOCK_REFUSAL =
  "Blocked on yourself is not blocked. Keep working on the task, or set it to backlog and write the dependency in the " +
  "description. For a wait outside the Guild (Anton, a host, a vendor), open a card: a pending card lets the issue be blocked.";

/** True when the unblock-request wake would only wake the issue's own assignee. */
export function skipSelfUnblockWake(issue: { assigneeAgentId?: string | null; unblockDescriptor?: unknown }): boolean {
  if (!selfBlockGuardEnabled()) return false;
  const owner = (issue.unblockDescriptor as { owner?: unknown } | null | undefined)?.owner;
  const agentId = owner && typeof owner === "object" && "agentId" in owner ? (owner as { agentId?: unknown }).agentId : null;
  return typeof agentId === "string" && agentId === issue.assigneeAgentId;
}
