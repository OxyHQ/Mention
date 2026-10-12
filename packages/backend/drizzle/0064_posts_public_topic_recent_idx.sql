-- Recent public posts with classified topics, newest first (topic affinity).
--
-- `ContentAffinityService.computeTopicAffinity` asks it for every viewer whose
-- affinity cache (120 s) has expired, from both the For You affinity lane and
-- who-to-follow. Nothing served it: Postgres ANDed a GIN bitmap of every post
-- that ever matched the viewer's topics with a 30-day `created_at` bitmap,
-- lossy at the default `work_mem`, then sorted. Measured in production
-- (EXPLAIN ANALYZE, 2026-10-11): 30k buffers, 0.7 s cold on an idle database;
-- the slow-query log has it at 30-96 s while the shared instance was busy.
-- Rebuilt on a copy of production's 1.9M posts: an index-only walk of this
-- index, ~1k buffers, under 15 ms cold, stable across prepared executions.
--
-- Partial on `cardinality(classification_topics) > 0` (~8% of posts, 19 MB).
-- `classification_topics` already carries a GIN index, so the classification
-- write was never a HOT update; the engagement counters are not in this index.
--
-- This uses the existing transactional migrator: CONCURRENTLY is unavailable.
-- CREATE INDEX takes SHARE: reads continue, writes wait until the transaction
-- commits. Refuse after 5s acquiring locks or 60s building, rather than create
-- an unbounded write stall. A failure rolls back the index and ledger entry.
-- It built in 0.4 s on the production copy. IF NOT EXISTS so that, should the
-- build ever exceed the budget, the index can be built CONCURRENTLY by hand and
-- the next deploy passes over it.
-- Preserve the connection settings for any later migration in this transaction.
SELECT set_config('mention.public_topic_recent_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.public_topic_recent_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_public_topic_recent_idx" ON "posts" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST,"oxy_user_id","classification_topics") WHERE "posts"."visibility" = 'public' and "posts"."status" = 'published' and "posts"."type" <> 'boost' and "posts"."oxy_user_id" is not null and cardinality("posts"."classification_topics") > 0;
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.public_topic_recent_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.public_topic_recent_statement_timeout'), true);
