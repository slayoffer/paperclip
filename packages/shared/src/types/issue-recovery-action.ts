import type { IssueRecoveryActionKind, IssueRecoveryActionStatus, IssueRecoveryActionOwnerType, IssueRecoveryActionOutcome } from "../constants.js";

export interface IssueRecoveryAction {
  /** Read-only activity of the exact native run named by the wake policy. */
  nativeRunActivity?: {
    runId: string;
    status: "queued" | "running";
    workspaceOperationId: string | null;
  } | null;
  id: string;
  companyId: string;
  sourceIssueId: string;
  recoveryIssueId: string | null;
  kind: IssueRecoveryActionKind;
  status: IssueRecoveryActionStatus;
  ownerType: IssueRecoveryActionOwnerType;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  previousOwnerAgentId: string | null;
  returnOwnerAgentId: string | null;
  cause: string;
  fingerprint: string;
  evidence: Record<string, unknown>;
  nextAction: string;
  wakePolicy: Record<string, unknown> | null;
  monitorPolicy: Record<string, unknown> | null;
  attemptCount: number;
  maxAttempts: number | null;
  timeoutAt: Date | string | null;
  lastAttemptAt: Date | string | null;
  outcome: IssueRecoveryActionOutcome | null;
  resolutionNote: string | null;
  resolvedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}
