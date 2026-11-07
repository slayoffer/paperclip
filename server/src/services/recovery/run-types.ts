import type { heartbeatRuns } from "@paperclipai/db";

export type LatestIssueRun =
  | (Pick<
      typeof heartbeatRuns.$inferSelect,
      | "id"
      | "agentId"
      | "status"
      | "error"
      | "errorCode"
      | "contextSnapshot"
      | "livenessState"
      | "startedAt"
      | "createdAt"
    > & {
      resultJson?: unknown;
    })
  | null;
