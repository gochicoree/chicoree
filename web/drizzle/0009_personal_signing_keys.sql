CREATE TABLE "user_signing_keys" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"public_key_pem" text NOT NULL,
	"fingerprint" text NOT NULL,
	"key_type" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_signing_keys_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "trust_member_keys" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "manifest_signatures" ADD COLUMN "user_key_id" text;--> statement-breakpoint
ALTER TABLE "user_signing_keys" ADD CONSTRAINT "user_signing_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_signing_keys_user_idx" ON "user_signing_keys" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "manifest_signatures" ADD CONSTRAINT "manifest_signatures_user_key_id_user_signing_keys_id_fk" FOREIGN KEY ("user_key_id") REFERENCES "public"."user_signing_keys"("id") ON DELETE set null ON UPDATE no action;