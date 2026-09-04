CREATE TABLE "organization_redirects" (
	"old_slug" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "repository_redirects" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_slug" text NOT NULL,
	"repository_name" text NOT NULL,
	"repository_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "repository_redirects_name_uq" UNIQUE("organization_slug","repository_name")
);
--> statement-breakpoint
CREATE TABLE "repository_stars" (
	"user_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_stars_user_id_repository_id_pk" PRIMARY KEY("user_id","repository_id")
);
--> statement-breakpoint
CREATE TABLE "repository_visits" (
	"user_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"last_visited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"visits" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "repository_visits_user_id_repository_id_pk" PRIMARY KEY("user_id","repository_id")
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"repository" text NOT NULL,
	"offset" bigint DEFAULT 0 NOT NULL,
	"chunks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"node" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_findings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"vulnerability_id" text NOT NULL,
	"package" text NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"fixed_in" text,
	"severity" text NOT NULL,
	"type" text DEFAULT 'os' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vulnerability_exceptions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"repository_id" text,
	"vulnerability_id" text NOT NULL,
	"package" text,
	"justification" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_signing_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"public_key_pem" text NOT NULL,
	"private_key_encrypted" text NOT NULL,
	"algorithm" text DEFAULT 'ES256' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "manifest_artifacts" (
	"repository_id" text NOT NULL,
	"digest" text NOT NULL,
	"subject_digest" text NOT NULL,
	"kind" text NOT NULL,
	"subkind" text,
	"format" text DEFAULT 'unknown' NOT NULL,
	"summary" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manifest_artifacts_repository_id_digest_pk" PRIMARY KEY("repository_id","digest")
);
--> statement-breakpoint
CREATE TABLE "manifest_signatures" (
	"repository_id" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"signature_digest" text NOT NULL,
	"kind" text DEFAULT 'signature' NOT NULL,
	"status" text NOT NULL,
	"key_id" text,
	"identity" text,
	"details" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manifest_signatures_repository_id_manifest_digest_signature_digest_pk" PRIMARY KEY("repository_id","manifest_digest","signature_digest")
);
--> statement-breakpoint
CREATE TABLE "signing_keys_trusted" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"repository_id" text,
	"name" text NOT NULL,
	"public_key_pem" text NOT NULL,
	"fingerprint" text NOT NULL,
	"key_type" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_tokens" ADD COLUMN "last_used_ip" text;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD COLUMN "repository_ids" jsonb;--> statement-breakpoint
ALTER TABLE "manifest_blocks" ADD COLUMN "pushers_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "require_signature" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "readme" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "require_signature" boolean;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "last_used_ip" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "onboarding_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "admin_checklist_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vulnerability_scans" ADD COLUMN "findings" jsonb;--> statement-breakpoint
ALTER TABLE "vulnerability_scans" ADD COLUMN "scanner" text;--> statement-breakpoint
ALTER TABLE "vulnerability_scans" ADD COLUMN "scanner_version" text;--> statement-breakpoint
ALTER TABLE "organization_redirects" ADD CONSTRAINT "organization_redirects_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_redirects" ADD CONSTRAINT "repository_redirects_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_stars" ADD CONSTRAINT "repository_stars_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_stars" ADD CONSTRAINT "repository_stars_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_visits" ADD CONSTRAINT "repository_visits_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_visits" ADD CONSTRAINT "repository_visits_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_exceptions" ADD CONSTRAINT "vulnerability_exceptions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_exceptions" ADD CONSTRAINT "vulnerability_exceptions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_signing_keys" ADD CONSTRAINT "token_signing_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_artifacts" ADD CONSTRAINT "manifest_artifacts_manifest_fk" FOREIGN KEY ("repository_id","digest") REFERENCES "public"."manifests"("repository_id","digest") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_signatures" ADD CONSTRAINT "manifest_signatures_key_id_signing_keys_trusted_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."signing_keys_trusted"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_signatures" ADD CONSTRAINT "manifest_signatures_signature_fk" FOREIGN KEY ("repository_id","signature_digest") REFERENCES "public"."manifests"("repository_id","digest") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_signatures" ADD CONSTRAINT "manifest_signatures_subject_fk" FOREIGN KEY ("repository_id","manifest_digest") REFERENCES "public"."manifests"("repository_id","digest") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_keys_trusted" ADD CONSTRAINT "signing_keys_trusted_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_keys_trusted" ADD CONSTRAINT "signing_keys_trusted_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_keys_trusted" ADD CONSTRAINT "signing_keys_trusted_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_redirects_repo_idx" ON "repository_redirects" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "repository_stars_repo_idx" ON "repository_stars" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "repository_visits_user_idx" ON "repository_visits" USING btree ("user_id","last_visited_at");--> statement-breakpoint
CREATE INDEX "upload_sessions_expires_idx" ON "upload_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "scan_findings_digest_idx" ON "scan_findings" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "scan_findings_vuln_idx" ON "scan_findings" USING btree ("vulnerability_id");--> statement-breakpoint
CREATE INDEX "scan_findings_package_idx" ON "scan_findings" USING btree ("package");--> statement-breakpoint
CREATE INDEX "vulnerability_exceptions_org_idx" ON "vulnerability_exceptions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "vulnerability_exceptions_vuln_idx" ON "vulnerability_exceptions" USING btree ("vulnerability_id");--> statement-breakpoint
CREATE INDEX "manifest_artifacts_subject_idx" ON "manifest_artifacts" USING btree ("repository_id","subject_digest");--> statement-breakpoint
CREATE INDEX "manifest_signatures_subject_idx" ON "manifest_signatures" USING btree ("repository_id","manifest_digest","status");--> statement-breakpoint
CREATE INDEX "signing_keys_trusted_org_idx" ON "signing_keys_trusted" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "signing_keys_trusted_repo_idx" ON "signing_keys_trusted" USING btree ("repository_id");--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repositories_name_trgm_idx" ON "repositories" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repositories_description_trgm_idx" ON "repositories" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tags_name_trgm_idx" ON "tags" USING gin ("name" gin_trgm_ops);
