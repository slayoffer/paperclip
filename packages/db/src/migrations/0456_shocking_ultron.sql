-- paperclip:migration-safety-ignore large-create-index-not-concurrently: The migration runner uses one transaction. This index scans the measured 55500-row table once, with no backfill. Homelab must allow the table write lock during deployment.
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_company_idempotency_idx" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key");
