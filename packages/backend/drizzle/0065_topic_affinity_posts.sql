-- oxy:deploy-phase=pre
-- The posts topic affinity reads, as a narrow materialized view.
--
-- `ContentAffinityService.computeTopicAffinity` runs on the request path of the
-- For You feed and who-to-follow. On `posts` it read up to ~17k heap pages per
-- call (pages the engagement counters keep rewriting, so never all-visible and
-- rarely cached): slow-query median 18 s in a normal week (2026-10-03..09),
-- 5-10 s cold even after 0064. This view holds only the ~22k eligible rows of
-- the last 30 days, and `TopicAffinityRefreshJob` refreshes it CONCURRENTLY on
-- the leader.
--
-- Built WITH DATA so the first read after deploy has rows; the eligible window
-- is served by 0064's partial index. Bounded like 0052: refuse after 5s
-- acquiring locks or 60s running rather than stall writes to `posts`.
SELECT set_config('mention.topic_affinity_posts_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.topic_affinity_posts_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."topic_affinity_posts" AS (select "posts"."id" as post_id, "posts"."oxy_user_id" as oxy_user_id, "posts"."created_at" as created_at, "posts"."classification_topics" as topics from "posts" where "posts"."visibility" = 'public' and "posts"."status" = 'published' and "posts"."type" <> 'boost' and "posts"."oxy_user_id" is not null and cardinality("posts"."classification_topics") > 0 and "posts"."created_at" >= now() - interval '30 days');
--> statement-breakpoint
-- REFRESH ... CONCURRENTLY requires a unique index covering every row.
CREATE UNIQUE INDEX "topic_affinity_posts_post_id_key" ON "topic_affinity_posts" USING btree ("post_id");
--> statement-breakpoint
-- The read walks newest first and stops at its row cap.
CREATE INDEX "topic_affinity_posts_recent_idx" ON "topic_affinity_posts" USING btree ("created_at" DESC NULLS LAST,"post_id" DESC NULLS LAST);
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.topic_affinity_posts_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.topic_affinity_posts_statement_timeout'), true);
