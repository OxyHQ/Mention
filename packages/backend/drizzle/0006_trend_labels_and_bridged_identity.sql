CREATE TABLE "trend_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"term" text NOT NULL,
	"run_started_at" timestamp with time zone NOT NULL,
	"description" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trend_summaries_term_run_started_at_key" UNIQUE("term","run_started_at")
);
--> statement-breakpoint
ALTER TABLE "trending" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "trending" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "trending" ADD COLUMN "label_version" integer;--> statement-breakpoint
ALTER TABLE "trending" ADD COLUMN "languages" text[];--> statement-breakpoint
ALTER TABLE "trending" ADD COLUMN "author_count" integer;--> statement-breakpoint
ALTER TABLE "trending" ADD COLUMN "burst_score" double precision;--> statement-breakpoint
ALTER TABLE "trending" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trending" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "trending" ADD COLUMN "actor_ids" text[];--> statement-breakpoint
ALTER TABLE "federated_actors" ADD COLUMN "network_acct" text;--> statement-breakpoint
CREATE INDEX "trend_summaries_generated_at_idx" ON "trend_summaries" USING btree ("generated_at");--> statement-breakpoint
CREATE INDEX "federated_actors_network_acct_idx" ON "federated_actors" USING btree ("network_acct") WHERE "federated_actors"."network_acct" is not null;--> statement-breakpoint
ALTER TABLE "trending" ADD CONSTRAINT "trending_category_check" CHECK ("trending"."category" is null or "trending"."category" in ('news', 'politics', 'sports', 'pop-culture', 'video-games', 'tech', 'science', 'other'));--> statement-breakpoint
ALTER TABLE "trending" ADD CONSTRAINT "trending_status_check" CHECK ("trending"."status" is null or "trending"."status" in ('hot'));