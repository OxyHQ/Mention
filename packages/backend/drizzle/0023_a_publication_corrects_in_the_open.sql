CREATE TABLE "post_corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"revision" integer NOT NULL,
	"previous_text" text NOT NULL,
	"corrected_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "post_corrections_post_id_revision_key" UNIQUE("post_id","revision"),
	CONSTRAINT "post_corrections_revision_check" CHECK ("post_corrections"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "correction_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "last_corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_corrections" ADD CONSTRAINT "post_corrections_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;