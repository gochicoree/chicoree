CREATE TABLE "quota_breaches" (
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"first_over_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_bytes" bigint NOT NULL,
	"limit_bytes" bigint NOT NULL,
	"notified_at" timestamp with time zone,
	"final_notice_at" timestamp with time zone,
	"pruned_at" timestamp with time zone,
	CONSTRAINT "quota_breaches_target_type_target_id_pk" PRIMARY KEY("target_type","target_id")
);
