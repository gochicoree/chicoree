CREATE TABLE "login_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_event_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"repository" text NOT NULL,
	"digest" text,
	"tag" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"media_type" text,
	"actor" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "signing_identities_trusted" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"repository_id" text,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repository_webhooks" ADD COLUMN "format" text DEFAULT 'json' NOT NULL;--> statement-breakpoint
ALTER TABLE "manifest_signatures" ADD COLUMN "identity_id" text;--> statement-breakpoint
ALTER TABLE "signing_identities_trusted" ADD CONSTRAINT "signing_identities_trusted_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_identities_trusted" ADD CONSTRAINT "signing_identities_trusted_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_identities_trusted" ADD CONSTRAINT "signing_identities_trusted_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_attempts_updated_idx" ON "login_attempts" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "registry_event_outbox_pending_idx" ON "registry_event_outbox" USING btree ("delivered_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "signing_identities_trusted_org_idx" ON "signing_identities_trusted" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "signing_identities_trusted_repo_idx" ON "signing_identities_trusted" USING btree ("repository_id");--> statement-breakpoint
ALTER TABLE "manifest_signatures" ADD CONSTRAINT "manifest_signatures_identity_id_signing_identities_trusted_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."signing_identities_trusted"("id") ON DELETE set null ON UPDATE no action;