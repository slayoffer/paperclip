CREATE TABLE "tool_oauth_card_projections" (
	"interaction_id" uuid NOT NULL,
	"card_generation" text NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_source" text,
	"resolved_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_oauth_card_projections_generation_pk" PRIMARY KEY("interaction_id","card_generation"),
	CONSTRAINT "tool_oauth_card_projections_outcome_check" CHECK ("tool_oauth_card_projections"."outcome" in ('accepted', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "tool_oauth_card_projections" ADD CONSTRAINT "tool_oauth_card_projections_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_oauth_card_projections" ADD CONSTRAINT "tool_oauth_card_projections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_oauth_card_projections_company_idx" ON "tool_oauth_card_projections" USING btree ("company_id");