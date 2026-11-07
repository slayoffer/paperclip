ALTER TABLE "heartbeat_runs"
  ADD COLUMN "context_task_identity" jsonb GENERATED ALWAYS AS (coalesce(nullif(context_snapshot -> 'issueId', 'null'::jsonb), nullif(context_snapshot -> 'taskId', 'null'::jsonb) )) STORED,
  ADD COLUMN "writes_revoked" boolean GENERATED ALWAYS AS (status = 'cancelled' or coalesce(jsonb_typeof(result_json -> 'executionCancellation') = 'object' and result_json -> 'executionCancellation' -> 'state' = '"requested"'::jsonb, false)) STORED,
  ADD COLUMN "conversation_mode" boolean GENERATED ALWAYS AS (coalesce(context_snapshot -> 'conversationMode' = 'true'::jsonb, false)) STORED,
  ADD COLUMN "context_issue_id" text GENERATED ALWAYS AS (context_snapshot ->> 'issueId') STORED,
  ADD COLUMN "context_task_id" text GENERATED ALWAYS AS (context_snapshot ->> 'taskId') STORED;
--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_agent_activity_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","created_at","context_issue_id","context_task_id");
