import type { AttentionResolverAudience, IssueThreadInteractionEffectiveResolverPolicySource, IssueThreadInteractionResolverPolicyProvenance } from "@paperclipai/shared";
import { canonicalizeStoredResolverPolicy } from "./issue-thread-interaction-resolution.js";

export function interactionResolverAudience(
  row: {
    addresseeAgentId: string | null;
    addresseeUserId?: string | null;
    createdByAgentId: string | null;
    requestedResolverPolicy: string;
    effectiveResolverPolicy: string;
    resolverPolicyProvenance: string | null;
    effectiveResolverPolicySource: string | null;
  },
  agentName: (agentId: string) => string | null,
): AttentionResolverAudience {
  const provenance = (row.resolverPolicyProvenance
    ?? (row.requestedResolverPolicy === "board_only" || row.requestedResolverPolicy === "board_or_agents"
      ? "legacy_inherited_restriction"
      : "inherited")) as IssueThreadInteractionResolverPolicyProvenance;
  return {
    requestedResolverPolicy: canonicalizeStoredResolverPolicy(row.requestedResolverPolicy, provenance),
    effectiveResolverPolicy: canonicalizeStoredResolverPolicy(row.effectiveResolverPolicy, provenance),
    effectiveResolverPolicySource:
      (row.effectiveResolverPolicySource ?? "requested") as IssueThreadInteractionEffectiveResolverPolicySource,
    resolverPolicyProvenance: provenance,
    addresseeAgentId: row.addresseeAgentId,
    addresseeUserId: row.addresseeUserId ?? null,
    addresseeName: row.addresseeAgentId ? agentName(row.addresseeAgentId) : null,
    createdByAgentId: row.createdByAgentId,
    createdByAgentName: row.createdByAgentId ? agentName(row.createdByAgentId) : null,
  };
}
