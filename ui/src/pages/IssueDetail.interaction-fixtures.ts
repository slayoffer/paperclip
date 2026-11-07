import type { RequestConfirmationInteraction } from "@paperclipai/shared";

export function createPendingCompletionInteraction(revision?: string) {
  return {
    id: "interaction-continue",
    revision,
    companyId: "company-1",
    issueId: "issue-1",
    kind: "request_confirmation",
    title: "Review completion",
    summary: null,
    status: "pending",
    continuationPolicy: "wake_assignee",
    resolverPolicy: "human_only",
    requestedResolverPolicy: "human_only",
    effectiveResolverPolicy: "human_only",
    resolverPolicyProvenance: "explicit",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: {
      requested: "board_only",
      effective: "board_only",
    },
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-09-06T12:00:00.000Z"),
    updatedAt: new Date("2026-09-06T12:00:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      prompt: "Is this task ready to complete?",
      acceptLabel: "Approve completion",
      rejectLabel: "Continue work",
    },
    result: null,
  } satisfies RequestConfirmationInteraction;
}
