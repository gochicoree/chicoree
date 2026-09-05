CREATE TABLE "api_request_stats" (
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"status" integer NOT NULL,
	"credential" text NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_request_stats_endpoint_method_status_credential_pk" PRIMARY KEY("endpoint","method","status","credential")
);
--> statement-breakpoint
CREATE TABLE "ci_identities_trusted" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"permission" text DEFAULT 'push' NOT NULL,
	"repository_ids" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_subject" text
);
--> statement-breakpoint
ALTER TABLE "ci_identities_trusted" ADD CONSTRAINT "ci_identities_trusted_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_identities_trusted" ADD CONSTRAINT "ci_identities_trusted_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_identities_trusted_org_idx" ON "ci_identities_trusted" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ci_identities_trusted_issuer_idx" ON "ci_identities_trusted" USING btree ("issuer");