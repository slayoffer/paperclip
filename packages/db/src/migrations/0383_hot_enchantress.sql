ALTER TABLE "issue_thread_interactions" ADD COLUMN "resolved_via" text;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN "resolved_via_key_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_resolved_via_check" CHECK ("issue_thread_interactions"."resolved_via" IN ('user_session', 'board_api_key', 'agent_key', 'chat_channel', 'system'));--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_resolved_via_key_check" CHECK (("issue_thread_interactions"."resolved_via" IS NOT DISTINCT FROM 'board_api_key') = ("issue_thread_interactions"."resolved_via_key_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_resolved_via_timestamp_check" CHECK ("issue_thread_interactions"."resolved_at" IS NOT NULL OR ("issue_thread_interactions"."resolved_via" IS NULL AND "issue_thread_interactions"."resolved_via_key_id" IS NULL));--> statement-breakpoint
CREATE FUNCTION preserve_interaction_resolved_via() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resolved_at IS NULL THEN
    NEW.resolved_via := NULL;
    NEW.resolved_via_key_id := NULL;
  ELSIF OLD.resolved_at IS NOT NULL AND (
    NEW.resolved_via IS DISTINCT FROM OLD.resolved_via OR
    NEW.resolved_via_key_id IS DISTINCT FROM OLD.resolved_via_key_id
  ) THEN
    RAISE EXCEPTION 'Interaction resolution channel is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER issue_thread_interactions_preserve_resolved_via
BEFORE UPDATE ON issue_thread_interactions
FOR EACH ROW EXECUTE FUNCTION preserve_interaction_resolved_via();
