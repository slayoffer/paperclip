import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const branch = z.string().regex(/^review\/[A-Z][A-Z0-9]*-[1-9][0-9]*$/);
const common = {
  requestId: z.string().uuid(),
  brokerId: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  runId: z.string().uuid(),
  issueId: z.string().uuid(),
  repository,
  branch,
  commitSha: sha,
};

// This contract has no HTTP route. Synthetic service callers supply verified identities separately.
export const publicationBindingsSchema = z.discriminatedUnion("operation", [
  z.object({ ...common, operation: z.literal("push"), expectedOldSha: sha }).strict(),
  z.object({
    ...common, operation: z.literal("create_pull_request"),
    sourceRepository: repository, sourceBranch: branch, headSha: sha,
  }).strict(),
  z.object({
    ...common, operation: z.literal("update_pull_request"),
    sourceRepository: repository, sourceBranch: branch, headSha: sha,
    pullRequestNumber: z.number().int().positive(),
  }).strict(),
]);

export type PublicationBindings = z.infer<typeof publicationBindingsSchema>;
export type PublicationRequestState = "pending" | "dispatched" | "unknown" | "succeeded" | "refused" | "revoked";

/** Internal authenticated context. Request JSON and identity headers cannot establish this context. */
export interface PublicationIdentity {
  companyId: string;
  brokerId: string;
  certificateId: string;
  issuerId: string;
  agentId: string;
  runId: string;
}

export interface PublicationDecision {
  dispatch: boolean;
  state: PublicationRequestState | "denied";
  reason: string;
  remainingLifetimeMs: number;
}

/** Apply at the actual write boundary. Start the monotonic timer before the authority request. */
export function publicationDispatchWithinDeadline(
  decision: PublicationDecision,
  requestStartedMs: number,
  writeBoundaryMs: number,
): boolean {
  const elapsed = writeBoundaryMs - requestStartedMs;
  return decision.dispatch && Number.isFinite(elapsed) && elapsed >= 0
    && Number.isFinite(decision.remainingLifetimeMs)
    && elapsed < Math.min(1000, decision.remainingLifetimeMs);
}
