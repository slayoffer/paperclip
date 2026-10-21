CREATE TABLE "interaction_resolution_outbox" (
	"interaction_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"wakes" jsonb NOT NULL,
	"authorization_context" jsonb,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN "revision" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN "resolution_request" jsonb;--> statement-breakpoint
ALTER TABLE "interaction_resolution_outbox" ADD CONSTRAINT "interaction_resolution_outbox_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_resolution_outbox" ADD CONSTRAINT "interaction_resolution_outbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_resolution_outbox" ADD CONSTRAINT "interaction_resolution_outbox_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interaction_resolution_outbox_pending_idx" ON "interaction_resolution_outbox" USING btree ("delivered_at","created_at");
--> statement-breakpoint

-- Every writer advances the opaque revision. This includes lifecycle and provider writers.
-- Do not derive this token from updated_at. Multiple writes can share one millisecond.
CREATE OR REPLACE FUNCTION paperclip_advance_interaction_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := gen_random_uuid();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER issue_thread_interactions_advance_revision
BEFORE UPDATE ON issue_thread_interactions
FOR EACH ROW EXECUTE FUNCTION paperclip_advance_interaction_revision();
