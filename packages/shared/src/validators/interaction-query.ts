import { z } from "zod";
import {
  ISSUE_THREAD_INTERACTION_STATUSES,
  ISSUE_THREAD_INTERACTION_KINDS,
  ISSUE_THREAD_INTERACTION_CANONICAL_RESOLVER_POLICIES,
  ISSUE_THREAD_INTERACTION_RESOLVER_POLICIES,
  ISSUE_THREAD_INTERACTION_RESOLVER_POLICY_PROVENANCES,
  ISSUE_THREAD_INTERACTION_EFFECTIVE_RESOLVER_POLICY_SOURCES,
  ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES,
} from "../constants.js";

export const issueThreadInteractionStatusSchema = z.enum(
  ISSUE_THREAD_INTERACTION_STATUSES,
);
export const issueThreadInteractionKindSchema = z.enum(
  ISSUE_THREAD_INTERACTION_KINDS,
);
export const listCompanyInteractionsQuerySchema = z.object({
  status: issueThreadInteractionStatusSchema.optional(),
  kind: issueThreadInteractionKindSchema.optional(),
  issueId: z.string().uuid().optional(),
  limit: z.string()
    .regex(/^[0-9]+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(1000))
    .optional()
    .default(1000),
  cursor: z.string().uuid().optional(),
});
export type ListCompanyInteractionsQuery = z.infer<typeof listCompanyInteractionsQuerySchema>;

export const issueThreadInteractionCanonicalResolverPolicySchema = z
  .enum(ISSUE_THREAD_INTERACTION_CANONICAL_RESOLVER_POLICIES)
  .describe("Canonical resolver audience: anyone, not_creator, or human_only.");
export const issueThreadInteractionResolverPolicySchema = z
  .enum(ISSUE_THREAD_INTERACTION_RESOLVER_POLICIES)
  .describe(
    "Resolver audience. Use anyone, not_creator, or human_only; board_or_agents and board_only are deprecated compatibility aliases.",
  );
export const issueThreadInteractionResolverPolicyProvenanceSchema = z.enum(
  ISSUE_THREAD_INTERACTION_RESOLVER_POLICY_PROVENANCES,
);
export const issueThreadInteractionEffectiveResolverPolicySourceSchema = z.enum(
  ISSUE_THREAD_INTERACTION_EFFECTIVE_RESOLVER_POLICY_SOURCES,
);
export const issueThreadInteractionContinuationPolicySchema = z.enum(
  ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES,
);
