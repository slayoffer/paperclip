ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "revision" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "resolution_request" jsonb;
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
