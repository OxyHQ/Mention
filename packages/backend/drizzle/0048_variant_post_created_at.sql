-- `post_content_variants` carries a copy of `posts.created_at`, so the posts
-- search can bound its text match by time on the table that holds the text
-- index (#1158).
--
-- WHY: the GIN index on `search_vector` lives here and the timestamp on `posts`,
-- and an index cannot span two tables. A search therefore fetched every
-- rendition matching its words, and every one of their posts, before it could
-- keep the newest 21. Measured in production (2026-09-25, cold cache):
--
--   word       matches   last 7 days   buffers read   time
--   climate      3,910            85          9,209    6.0 s
--   hello        3,103            56          7,109    4.6 s
--   rust         2,168            47          4,760    4.0 s
--
-- With this column and a btree on it, the GIN bitmap and a time-range bitmap
-- intersect, and only the matches inside a recent window are fetched.
--
-- THIS MIGRATION ONLY ADDS THE COLUMN. It is nullable with no default, so
-- `ADD COLUMN` rewrites nothing and holds its ACCESS EXCLUSIVE lock only for the
-- catalogue change. The backfill (1.2M rows, 833 MB) and the index are NOT
-- here: the migrator runs every file in one transaction, so an UPDATE here would
-- keep that lock, and with it every read of every post's text, for minutes.
-- `scripts/backfillVariantPostCreatedAt.ts` fills the column in short batches
-- and builds the index CONCURRENTLY; the search reads the column only once both
-- exist (a later migration declares the index with IF NOT EXISTS).
--
-- Refuse after 5 s waiting for the lock rather than queue every reader of
-- `post_content_variants` behind a long-running statement.
SELECT set_config('mention.variant_post_created_at_lock_timeout', current_setting('lock_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "post_content_variants" ADD COLUMN "post_created_at" timestamp with time zone;
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.variant_post_created_at_lock_timeout'), true);
