import { sql, type SQLWrapper } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

type RunTaskBinding = {
  nativeIssueId?: string | null;
  issueId?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

export function boundRunIssueId(run: RunTaskBinding): string | null {
  const values = [run.nativeIssueId, run.issueId, run.contextSnapshot?.issueId, run.contextSnapshot?.taskId];
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
}

export function boundRunIssueIdSql(run: {
  nativeIssueId: SQLWrapper;
  issueId: SQLWrapper;
  contextSnapshot: SQLWrapper;
} = heartbeatRuns) {
  return sql<string | null>`coalesce(${run.nativeIssueId}::text, ${run.issueId}::text,
    case when jsonb_typeof(${run.contextSnapshot}->'issueId') = 'string'
      then nullif(btrim(${run.contextSnapshot}->>'issueId'), '') end,
    case when jsonb_typeof(${run.contextSnapshot}->'taskId') = 'string'
      then nullif(btrim(${run.contextSnapshot}->>'taskId'), '') end)`;
}
