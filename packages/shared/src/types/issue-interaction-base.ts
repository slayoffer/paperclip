import type { IssueThreadInteractionContinuationPolicy, IssueThreadInteractionCanonicalResolverPolicy, IssueThreadInteractionEffectiveResolverPolicySource, IssueThreadInteractionKind, IssueThreadInteractionLegacyResolverPolicyAlias, IssueThreadInteractionResolverPolicyProvenance, IssueThreadInteractionStatus } from "../constants.js";

export interface IssueThreadInteractionActorFields {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  resolvedByAgentId?: string | null;
  resolvedByRunId?: string | null;
  resolvedByUserId?: string | null;
}

export interface IssueThreadInteractionBase extends IssueThreadInteractionActorFields {
  /** Opaque decision revision. Older servers can omit this field. */
  revision?: string;
  id: string;
  companyId: string;
  issueId: string;
  kind: IssueThreadInteractionKind;
  idempotencyKey?: string | null;
  originCommentIds?: string[];
  sourceCommentId?: string | null;
  sourceRunId?: string | null;
  sourceIdentityContextId?: string | null;
  addresseeAgentId?: string | null;
  addresseeUserId?: string | null;
  title?: string | null;
  summary?: string | null;
  status: IssueThreadInteractionStatus;
  continuationPolicy: IssueThreadInteractionContinuationPolicy;
  /** Read-time acceptance gate; omitted when no workspace preparation is pending. */
  acceptanceBlocker?: "workspace_sync_pending";
  /** @deprecated Read requestedResolverPolicy. Kept for API compatibility. */
  resolverPolicy: IssueThreadInteractionCanonicalResolverPolicy;
  requestedResolverPolicy: IssueThreadInteractionCanonicalResolverPolicy;
  effectiveResolverPolicy: IssueThreadInteractionCanonicalResolverPolicy;
  resolverPolicyProvenance: IssueThreadInteractionResolverPolicyProvenance;
  effectiveResolverPolicySource: IssueThreadInteractionEffectiveResolverPolicySource;
  legacyResolverPolicyAliases: {
    requested: IssueThreadInteractionLegacyResolverPolicyAlias | null;
    effective: IssueThreadInteractionLegacyResolverPolicyAlias | null;
  };
  createdAt: Date | string;
  updatedAt: Date | string;
  resolvedAt?: Date | string | null;
}
