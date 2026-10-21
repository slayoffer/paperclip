export type IssueUnblockOwner = { agentId: string } | { userId: string } | "board";

export interface IssueUnblockDescriptor {
  owner: IssueUnblockOwner;
  action: string;
  kind?: "external" | "human" | "date";
  until?: string;
}
