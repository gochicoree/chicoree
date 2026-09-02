CREATE TABLE "manifest_blocks" (
	"repository_id" text NOT NULL,
	"digest" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manifest_blocks_repository_id_digest_pk" PRIMARY KEY("repository_id","digest")
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "block_pulls_at" text;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "block_unrated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "block_pulls_at" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "block_unrated" boolean;--> statement-breakpoint
ALTER TABLE "manifest_blocks" ADD CONSTRAINT "manifest_blocks_manifest_fk" FOREIGN KEY ("repository_id","digest") REFERENCES "public"."manifests"("repository_id","digest") ON DELETE cascade ON UPDATE no action;