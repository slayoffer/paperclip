export type { IssueUnblockOwner, IssueUnblockDescriptor } from "./issue-unblock.js";

export interface IssueDependencyReadiness {
  isDependencyReady: boolean;
  unresolvedBlockerIds: string[];
  unresolvedBlockerIssueIds: string[];
  blockerIssueIds: string[];
  pendingFinalizeBlockerIssueIds: string[];
  unresolvedBlockerCount: number;
  allBlockersDone: boolean;
  issueId: string;
}
