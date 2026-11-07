/**
 * Self-block guard (synthiq fork, Anton 2026-10-17). Measured 2026-10-17 (14 h): 106 `issue_unblock_requested` runs,
 * 39% of Codex input tokens, all woke the issue's own assignee; in 74 the agent had named itself as unblock owner, up to
 * 15 times on one issue. With PAPERCLIP_SELF_BLOCK_GUARD=true:
 * - an agent cannot name itself as the unblock owner without a real wait target, and
 * - no unblock-request wake is sent to an issue's own assignee.
 */
export function selfBlockGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCLIP_SELF_BLOCK_GUARD === "true";
}

export const SELF_BLOCK_REFUSAL =
  "Blocked status needs an open blocker, a pending review or card, or a typed outside wait. " +
  "Continue the task until a real wait target exists.";

/** True when the unblock-request wake would only wake the issue's own assignee. */
export function skipSelfUnblockWake(issue: { assigneeAgentId?: string | null; unblockDescriptor?: unknown }): boolean {
  if (!selfBlockGuardEnabled()) return false;
  const owner = (issue.unblockDescriptor as { owner?: unknown } | null | undefined)?.owner;
  const agentId = owner && typeof owner === "object" && "agentId" in owner ? (owner as { agentId?: unknown }).agentId : null;
  return typeof agentId === "string" && agentId === issue.assigneeAgentId;
}
