-- Drop the two per-bucket sitemap indexes 0035 added (#1160).
--
-- WHY: they existed so each child sitemap could seek its own hash bucket when
-- it was built on demand. Since #1165 every sitemap is built in one pass by the
-- scheduler leader — one grouped read and one streamed, bucket-ordered read,
-- both scans of the whole eligible set — and nothing reads these any more.
-- Keeping them costs 297 MB (138 + 159) and a write on every insert into posts
-- AND on every update of `updated_at`, which `posts_seo_profile_bucket_idx`
-- indexes: a post whose `updated_at` moves can never take a HOT update.
--
-- DROP INDEX takes ACCESS EXCLUSIVE on posts for the catalogue change, which is
-- instant once granted but queues every reader behind any long statement already
-- running. Refuse after 5 s waiting rather than stall the table; the 30-45 s
-- sitemap reads that made that likely are gone with #1165.
SELECT set_config('mention.seo_bucket_drop_lock_timeout', current_setting('lock_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "posts_seo_post_bucket_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "posts_seo_profile_bucket_idx";
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.seo_bucket_drop_lock_timeout'), true);
