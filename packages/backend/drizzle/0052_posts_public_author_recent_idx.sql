-- Which accounts published publicly inside a recent window (#1166).
--
-- `followerSnapshotJob.selectAuthorsToSample` asks it every sweep, and nothing
-- served it: a parallel sequential scan of all of `posts` to keep ~10% of the
-- rows. Measured in production (EXPLAIN ANALYZE, 2026-09-26): 135k blocks read,
-- 5.2 s cold, for 22,813 distinct authors out of 134k posts in fourteen days.
-- The predicate is that query's WHERE and `oxy_user_id` rides in the key, so
-- the window becomes an index-only range scan.
--
-- Neither indexed column is written after a post is created, so HOT updates of
-- the engagement counters are unaffected.
--
-- This uses the existing transactional migrator: CONCURRENTLY is unavailable.
-- CREATE INDEX takes SHARE: reads continue, writes wait until the transaction
-- commits. Refuse after 5s acquiring locks or 60s building, rather than create
-- an unbounded write stall. A failure rolls back the index and ledger entry.
-- 0039 built the same shape of index over the same ~1.5M rows inside that
-- budget. IF NOT EXISTS so that, should the build ever exceed it, the index
-- can be built CONCURRENTLY by hand and the next deploy passes over it.
-- Preserve the connection settings for any later migration in this transaction.
SELECT set_config('mention.public_author_recent_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.public_author_recent_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_public_author_recent_idx" ON "posts" USING btree ("created_at","oxy_user_id") WHERE "posts"."visibility" = 'public' and "posts"."status" = 'published';
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.public_author_recent_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.public_author_recent_statement_timeout'), true);
