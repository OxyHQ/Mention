-- oxy:deploy-phase=pre
-- The window scan trending reads every batch: original (not boosted) public
-- posts of the last 48 hours.
--
-- post_public_chrono_v1 cannot see boost_of, so the planner walks every boost in
-- the window and discards it at the heap. Measured in production (EXPLAIN
-- ANALYZE, 2026-11-24): 330k rows read to keep 60k, 169k blocks from disk, 31 s
-- cold against the 15 s statement timeout, so the batch failed whenever the
-- cache was cold. Excluding boosts from the index makes the window a range scan
-- over the posts that are actually read.
--
-- created_at and boost_of are not written after a post is created, so HOT
-- updates of the engagement counters are unaffected.
--
-- posts is 10M rows / 7.5 GB: far past the 60 s budget of this transactional
-- migrator, and CREATE INDEX holds SHARE, so writes would stall for the whole
-- build. The index is therefore built CONCURRENTLY out of band first
-- (MIGRATION-CONTRACT.md), and IF NOT EXISTS lets this pass over it. Should it
-- be missing, the build is refused after 5s of locks or 60s rather than create
-- an unbounded write stall, and the deploy stops with the ledger untouched.
-- Preserve the connection settings for any later migration in this transaction.
SELECT set_config('mention.trending_originals_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.trending_originals_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_public_originals_recent_idx" ON "posts" USING btree ("created_at") WHERE "posts"."visibility" = 'public' and "posts"."status" = 'published' and "posts"."boost_of" is null;
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.trending_originals_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.trending_originals_statement_timeout'), true);
