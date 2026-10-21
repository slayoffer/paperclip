import { type ActiveRunForIssue, type LiveRunForIssue } from "../api/heartbeats";
import type { IssueChatComment } from "../lib/issue-chat-messages";

export function normalizePipelineConversationComments(value: unknown): IssueChatComment[] {
  return Array.isArray(value) ? value : [];
}

export function resolveRunningPipelineConversationRun(
  activeRun: ActiveRunForIssue | null | undefined,
  liveRuns: readonly LiveRunForIssue[] | undefined,
) {
  return activeRun?.status === "running"
    ? activeRun
    : (liveRuns ?? []).find((run) => run.status === "running") ?? null;
}
