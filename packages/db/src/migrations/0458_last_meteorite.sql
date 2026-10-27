ALTER TABLE "interaction_resolution_outbox" ADD COLUMN IF NOT EXISTS "hold_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "interaction_resolution_outbox" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interaction_resolution_outbox" ADD COLUMN IF NOT EXISTS "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interaction_resolution_outbox" ADD COLUMN IF NOT EXISTS "last_error_code" text;--> statement-breakpoint
ALTER TABLE "issue_question_response_deliveries" ADD COLUMN IF NOT EXISTS "hold_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_question_response_deliveries" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;