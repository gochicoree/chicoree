CREATE TABLE "scan_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"repository_id" text,
	"repository_path" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_by" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scan_tasks_digest_unique" UNIQUE("digest")
);
--> statement-breakpoint
CREATE TABLE "scan_workers" (
	"name" text PRIMARY KEY NOT NULL,
	"hostname" text,
	"version" text,
	"scanner_version" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"running" integer DEFAULT 0 NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "scan_tasks_status_idx" ON "scan_tasks" USING btree ("status","available_at");