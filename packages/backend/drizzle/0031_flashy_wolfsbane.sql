CREATE TABLE "trend_story_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"trend_id" text NOT NULL,
	"post_id" text NOT NULL,
	"relevance" double precision NOT NULL,
	"matched_terms" text[] NOT NULL,
	CONSTRAINT "trend_story_posts_trend_id_post_id_key" UNIQUE("trend_id","post_id"),
	CONSTRAINT "trend_story_posts_relevance_check" CHECK ("trend_story_posts"."relevance" >= 0 and "trend_story_posts"."relevance" <= 1)
);
--> statement-breakpoint
ALTER TABLE "trend_story_posts" ADD CONSTRAINT "trend_story_posts_trend_id_trending_id_fk" FOREIGN KEY ("trend_id") REFERENCES "public"."trending"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_story_posts" ADD CONSTRAINT "trend_story_posts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trend_story_posts_post_id_idx" ON "trend_story_posts" USING btree ("post_id");