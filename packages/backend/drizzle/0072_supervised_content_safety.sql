CREATE TABLE "post_safety_assessments" (
	"post_id" text PRIMARY KEY NOT NULL,
	"material_digest" text NOT NULL,
	"rating" text NOT NULL,
	"assessment_version" integer NOT NULL,
	"assessed_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "post_safety_rating_check" CHECK ("post_safety_assessments"."rating" in ('general', 'mature', 'unrated')),
	CONSTRAINT "post_safety_digest_check" CHECK ("post_safety_assessments"."material_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "post_safety_version_check" CHECK ("post_safety_assessments"."assessment_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "post_safety_assessments" ADD CONSTRAINT "post_safety_assessments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;