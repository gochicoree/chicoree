CREATE TABLE "job_schedules" (
	"job" text PRIMARY KEY NOT NULL,
	"cron" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_status" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" text NOT NULL,
	"event" text NOT NULL,
	"email" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_event_pk" PRIMARY KEY("user_id","event")
);
--> statement-breakpoint
CREATE TABLE "notification_state" (
	"key" text PRIMARY KEY NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_proxies" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"upstream_url" text NOT NULL,
	"preset" text DEFAULT 'custom' NOT NULL,
	"auth" text,
	"allowed_patterns" text DEFAULT '' NOT NULL,
	"tag_ttl_seconds" integer DEFAULT 300 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repository_traffic" (
	"repository_id" text NOT NULL,
	"day" date NOT NULL,
	"pull_bytes" bigint DEFAULT 0 NOT NULL,
	"push_bytes" bigint DEFAULT 0 NOT NULL,
	"redirect_bytes" bigint DEFAULT 0 NOT NULL,
	"blob_pulls" bigint DEFAULT 0 NOT NULL,
	"manifest_pulls" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "repository_traffic_repository_id_day_pk" PRIMARY KEY("repository_id","day")
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"repository_id" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"keep_last" integer,
	"keep_matching" text,
	"delete_older_than_days" integer,
	"delete_untagged_after_days" integer,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policies_scope_uq" UNIQUE NULLS NOT DISTINCT("organization_id","repository_id")
);
--> statement-breakpoint
CREATE TABLE "tag_rules" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"repository_id" text,
	"pattern" text NOT NULL,
	"immutable" boolean DEFAULT false NOT NULL,
	"protected" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_label" text DEFAULT '' NOT NULL,
	"impersonator_id" text,
	"action" text NOT NULL,
	"organization_id" text,
	"target_type" text,
	"target_id" text,
	"target_label" text,
	"details" jsonb,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "repository_webhooks" ALTER COLUMN "repository_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repository_webhooks" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "proxy_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "last_pulled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_proxies" ADD CONSTRAINT "organization_proxies_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_proxies" ADD CONSTRAINT "organization_proxies_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_traffic" ADD CONSTRAINT "repository_traffic_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_rules" ADD CONSTRAINT "tag_rules_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_rules" ADD CONSTRAINT "tag_rules_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_traffic_day_idx" ON "repository_traffic" USING btree ("day");--> statement-breakpoint
CREATE INDEX "tag_rules_org_idx" ON "tag_rules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tag_rules_repo_idx" ON "tag_rules" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_org_created_idx" ON "audit_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_created_idx" ON "audit_log" USING btree ("actor_id","created_at");--> statement-breakpoint
ALTER TABLE "repository_webhooks" ADD CONSTRAINT "repository_webhooks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_webhooks_org_idx" ON "repository_webhooks" USING btree ("organization_id");