CREATE TABLE "credential_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"permission_approval_id" uuid NOT NULL,
	"issuance_approval_id" uuid NOT NULL,
	"bindings" jsonb NOT NULL,
	"operation" jsonb NOT NULL,
	"state" text NOT NULL,
	"baseline_grant_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cleanup_ticket_id" uuid,
	"credential_id" text,
	"stored_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grant_deadline" timestamp with time zone NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credential_transfers" ADD CONSTRAINT "credential_transfers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credential_transfers_issuance_uq" ON "credential_transfers" USING btree ("company_id","issuance_approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_transfers_permission_uq" ON "credential_transfers" USING btree ("company_id","permission_approval_id");--> statement-breakpoint
CREATE INDEX "credential_transfers_cleanup_idx" ON "credential_transfers" USING btree ("state","grant_deadline");