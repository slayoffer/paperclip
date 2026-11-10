ALTER TABLE "issue_thread_interactions" ADD COLUMN "resolved_via" text;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_resolved_via_check" CHECK ("issue_thread_interactions"."resolved_via" IN ('user_session', 'board_api_key', 'agent_key'));--> statement-breakpoint
CREATE FUNCTION preserve_interaction_resolved_via() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.resolved_at IS NOT NULL OR OLD.status <> 'pending')
     AND NEW.resolved_via IS DISTINCT FROM OLD.resolved_via THEN
    RAISE EXCEPTION 'Interaction resolution channel is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER issue_thread_interactions_preserve_resolved_via
BEFORE UPDATE ON issue_thread_interactions
FOR EACH ROW EXECUTE FUNCTION preserve_interaction_resolved_via();
