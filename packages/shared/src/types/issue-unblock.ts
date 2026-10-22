export type IssueUnblockOwner = { agentId: string } | { userId: string } | "board";

export interface IssueUnblockDescriptor {
  owner: IssueUnblockOwner;
  action: string;
  kind?: "external" | "human" | "date" | "review_bridge";
  until?: string;
  bridge?: {
    waitId: string;
    repo: string;
    head: string;
    pr?: number;
    stage: "verdict" | "merge_card" | "lane_admission";
  };
}
