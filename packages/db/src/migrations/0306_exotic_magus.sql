CREATE TABLE "publication_authority_clocks" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"last_time_ms" bigint NOT NULL,
	"last_monotonic_ms" bigint NOT NULL,
	"clock_epoch" text NOT NULL,
	"uncertain" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publication_brokers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"certificate_id" text NOT NULL,
	"issuer_id" text NOT NULL,
	"valid_from_ms" bigint NOT NULL,
	"valid_until_ms" bigint NOT NULL,
	"revoked_at" timestamp with time zone,
	"issuer_revoked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "publication_brokers_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "publication_brokers_certificate_uq" UNIQUE("issuer_id","certificate_id"),
	CONSTRAINT "publication_brokers_validity" CHECK ("publication_brokers"."valid_until_ms" > "publication_brokers"."valid_from_ms")
);
--> statement-breakpoint
CREATE TABLE "publication_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"broker_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"branch" text NOT NULL,
	"bindings" jsonb NOT NULL,
	"issued_at_ms" bigint NOT NULL,
	"issued_monotonic_ms" bigint NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"dispatched_at_ms" bigint,
	"revoked_at" timestamp with time zone,
	"reconciliation_id" uuid,
	CONSTRAINT "publication_requests_lifetime" CHECK ("publication_requests"."expires_at_ms" > "publication_requests"."issued_at_ms" and "publication_requests"."expires_at_ms" <= "publication_requests"."issued_at_ms" + 30000),
	CONSTRAINT "publication_requests_state" CHECK ("publication_requests"."state" in ('pending', 'dispatched', 'unknown', 'succeeded', 'refused', 'revoked')),
	CONSTRAINT "publication_requests_dispatch" CHECK (("publication_requests"."state" in ('pending', 'revoked') and "publication_requests"."dispatched_at_ms" is null) or ("publication_requests"."state" in ('dispatched', 'unknown', 'succeeded', 'refused') and "publication_requests"."dispatched_at_ms" is not null))
);
--> statement-breakpoint
ALTER TABLE "publication_authority_clocks" ADD CONSTRAINT "publication_authority_clocks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_brokers" ADD CONSTRAINT "publication_brokers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_requests" ADD CONSTRAINT "publication_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_requests" ADD CONSTRAINT "publication_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_requests" ADD CONSTRAINT "publication_requests_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_requests" ADD CONSTRAINT "publication_requests_company_id_broker_id_publication_brokers_company_id_id_fk" FOREIGN KEY ("company_id","broker_id") REFERENCES "public"."publication_brokers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_requests" ADD CONSTRAINT "publication_requests_company_id_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publication_requests_company_issue_idx" ON "publication_requests" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_requests_outstanding_uq" ON "publication_requests" USING btree ("company_id","repository","branch") WHERE "publication_requests"."state" in ('dispatched', 'unknown');
--> statement-breakpoint
-- Drizzle does not generate triggers. Preserve bindings, expiry, and single use at the storage boundary.
CREATE FUNCTION "publication_request_preserve_authority"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Publication request history cannot be deleted';
  END IF;
  IF ROW(NEW.id, NEW.company_id, NEW.broker_id, NEW.issue_id, NEW.agent_id, NEW.run_id,
         NEW.repository, NEW.branch, NEW.bindings, NEW.issued_at_ms, NEW.issued_monotonic_ms, NEW.expires_at_ms)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.company_id, OLD.broker_id, OLD.issue_id, OLD.agent_id, OLD.run_id,
         OLD.repository, OLD.branch, OLD.bindings, OLD.issued_at_ms, OLD.issued_monotonic_ms, OLD.expires_at_ms) THEN
    RAISE EXCEPTION 'Publication bindings and lifetime are immutable';
  END IF;
  IF OLD.dispatched_at_ms IS NOT NULL AND NEW.dispatched_at_ms IS DISTINCT FROM OLD.dispatched_at_ms THEN
    RAISE EXCEPTION 'Publication dispatch is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'Publication revocation is immutable';
  END IF;
  IF OLD.reconciliation_id IS NOT NULL AND NEW.reconciliation_id IS DISTINCT FROM OLD.reconciliation_id THEN
    RAISE EXCEPTION 'Publication reconciliation is immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'pending' AND NEW.state IN ('dispatched', 'revoked')) OR
    (OLD.state = 'dispatched' AND NEW.state IN ('unknown', 'succeeded', 'refused')) OR
    (OLD.state = 'unknown' AND NEW.state IN ('succeeded', 'refused') AND NEW.reconciliation_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Publication state transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "publication_request_preserve_authority"
BEFORE UPDATE OR DELETE ON "publication_requests"
FOR EACH ROW EXECUTE FUNCTION "publication_request_preserve_authority"();
--> statement-breakpoint
CREATE TRIGGER "publication_request_preserve_history"
BEFORE TRUNCATE ON "publication_requests"
FOR EACH STATEMENT EXECUTE FUNCTION "publication_request_preserve_authority"();
