export interface FlowIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  ageMs: number;
  unchangedForMs: number;
  openBlockerIds: string[];
  pendingDecisionCount: number;
}

export interface FlowAgent {
  id: string;
  name: string;
  status: string;
  wip: number;
  runnableWip: number;
  waitingWip: number;
  wipLimit: number | null;
  atWipLimit: boolean;
}

export type FlowStallReason =
  | "pending_decision"
  | "open_blocker"
  | "owner_at_wip_limit"
  | "owner_error"
  | "owner_paused"
  | "review_hold_without_round"
  | "in_progress_without_run"
  | "unassigned";

export interface FlowCounts {
  readyTodo: number;
  readyBacklog: number;
  chainRoots: number;
  wip: number;
  inProgressWithoutRun: number;
  blockedWithClosedLinks: number;
  reviewHoldsWithoutRound: number;
  unassigned: number;
}

export interface CompanyFlowReport {
  companyId: string;
  collectedAt: string;
  readyQueues: Array<{
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    todo: FlowIssue[];
    backlog: FlowIssue[];
  }>;
  chainRoots: Array<{
    issue: FlowIssue;
    transitiveDependentCount: number;
    owner: FlowAgent | null;
    reasons: FlowStallReason[];
  }>;
  agents: FlowAgent[];
  ghosts: {
    inProgressWithoutRun: FlowIssue[];
    blockedWithClosedLinks: FlowIssue[];
    reviewHoldsWithoutRound: FlowIssue[];
  };
  unassigned: FlowIssue[];
  counts: FlowCounts;
  /** Same title exclusions and WIP definition as the weekly Guild scorecard. */
  scorecard: {
    counts: FlowCounts;
    wip: number;
    byOwner: Array<{
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
      counts: FlowCounts;
      wip: number;
    }>;
  };
}
