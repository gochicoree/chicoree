ALTER TABLE "organization_limits" ADD COLUMN "max_members" integer;--> statement-breakpoint
ALTER TABLE "organization_limits" ADD COLUMN "label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_limits" ADD COLUMN "label" text DEFAULT '' NOT NULL;