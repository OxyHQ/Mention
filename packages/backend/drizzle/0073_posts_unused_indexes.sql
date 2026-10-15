-- Drop four `posts` indexes that production never reads.
--
-- Every insert into `posts`, and every update that is not HOT (3.3M of 4.4M so
-- far), writes an entry into each of its 32 indexes. These four hold 490 MB of
-- the table's 3.3 GB of index and, by `pg_stat_user_indexes` (never reset, so
-- the counters cover the table's whole life, 2026-10-15), are not read:
--
--   post_links_chrono_v1            236 MB   0 scans
--     Built for search's `filter:links`. A quarter of posts carry links, so the
--     planner fills a page from `post_public_chrono_v1` instead: 21 rows after
--     43 index entries, 48 buffers, 0.1 ms (EXPLAIN ANALYZE in production). The
--     `has_links = false` side it also indexed is asked for by nothing.
--
--   posts_type_chrono_idx           126 MB   16 scans, last 2026-08-05
--     Built for the global Media and Videos feeds. The Videos lane now drives
--     from `post_media_video_chrono_idx`, and the Media feed's `type` test is
--     one arm of an OR with two EXISTS, which no index can drive: production
--     plans it on `post_public_chrono_v1` (60 rows from 501 entries, 28 ms).
--     A bare `type in ('image', 'video')` plans there too, since a fifth of
--     posts match. The boost lookups that name `type` lead with `boost_of` or
--     the author and use those indexes.
--
--   posts_classification_queue_idx   83 MB   0 scans
--     Partial on `classification_status = 'pending'` for the Stage-B worker's
--     queue (0026). That worker is off in production (`POST_CLASSIFICATION_ENABLED`
--     is unset), so all 2.0M posts are still `pending` and the "partial" index
--     covers the whole table without the queue ever being read.
--
--   posts_public_topic_recent_idx    22 MB   887 scans, none since 2026-10-15 06:28
--     It served the refresh of the `topic_affinity_posts` materialized view
--     (0064/0065). Since 0067 that is a table kept by triggers, row by row, and
--     the index's last read (06:28:32) is the second production applied 0067,
--     whose one-time copy read it. No query in the tree spells its predicate.
--
-- DROP INDEX takes ACCESS EXCLUSIVE on `posts` until the migration commits, and
-- this migrator runs in a transaction, so CONCURRENTLY is not available. The
-- drops themselves are catalogue operations; the bound is on getting the lock:
-- refuse after 5 s waiting rather than queue every read of `posts` behind a
-- long-running query, like 0069.
SELECT set_config('mention.posts_unused_idx_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.posts_unused_idx_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
DROP INDEX IF EXISTS "post_links_chrono_v1";
--> statement-breakpoint
DROP INDEX IF EXISTS "posts_type_chrono_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "posts_public_topic_recent_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "posts_classification_queue_idx";
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.posts_unused_idx_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.posts_unused_idx_statement_timeout'), true);
