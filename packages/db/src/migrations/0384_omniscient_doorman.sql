ALTER TABLE "issue_comments" ADD COLUMN "author_auth_source" text;--> statement-breakpoint
CREATE FUNCTION preserve_comment_auth_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.author_auth_source IS DISTINCT FROM OLD.author_auth_source THEN
    RAISE EXCEPTION 'Comment authentication source is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER issue_comments_preserve_auth_source
BEFORE UPDATE ON issue_comments
FOR EACH ROW EXECUTE FUNCTION preserve_comment_auth_source();
