-- oxy:deploy-phase=pre
-- New private evidence tables; no historical-origin backfill.
CREATE TABLE "federation_post_import_reasons" (
	"post_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "federation_post_import_reasons_post_id_reason_pk" PRIMARY KEY("post_id","reason"),
	CONSTRAINT "federation_post_import_reasons_reason_check" CHECK ("federation_post_import_reasons"."reason" in ('discovery_backfill', 'followed_outbox', 'requested_profile', 'inbox_follow', 'inbox_mention', 'inbox_community', 'inbox_announce', 'boost_dependency', 'quote_dependency', 'reply_dependency', 'unknown_outbox'))
);
--> statement-breakpoint
CREATE TABLE "federation_post_imports" (
	"post_id" text PRIMARY KEY NOT NULL,
	"initial_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "federation_post_imports_reason_check" CHECK ("federation_post_imports"."initial_reason" in ('discovery_backfill', 'followed_outbox', 'requested_profile', 'inbox_follow', 'inbox_mention', 'inbox_community', 'inbox_announce', 'boost_dependency', 'quote_dependency', 'reply_dependency', 'unknown_outbox'))
);
--> statement-breakpoint
ALTER TABLE "federation_post_import_reasons" ADD CONSTRAINT "federation_post_import_reasons_post_id_federation_post_imports_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."federation_post_imports"("post_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_post_imports" ADD CONSTRAINT "federation_post_imports_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "federation_post_imports" VALIDATE CONSTRAINT "federation_post_imports_post_id_posts_id_fk";
