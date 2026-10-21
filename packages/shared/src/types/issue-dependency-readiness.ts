export type IssueUnblockOwner = { agentId: string } | { userId: string } | "board";

export interface IssueUnblockDescriptor {
  owner: IssueUnblockOwner;
  action: string;
}

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
