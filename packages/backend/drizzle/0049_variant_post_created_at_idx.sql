-- The btree the posts search's time windows intersect with the text index
-- (#1158; see `services/search/postSearch.ts` and 0048).
--
-- IF NOT EXISTS, because production already has it: the index was built
-- CONCURRENTLY — reads and writes of `post_content_variants` continuing — by
-- `scripts/backfillVariantPostCreatedAt.ts`, after that script filled the column
-- 0048 added. Here it is a no-op there, and the build for a fresh or test
-- database, where the table is small.
--
-- Should it ever run for real against a large table, CREATE INDEX takes SHARE:
-- reads continue and rendition writes wait. Refuse after 5 s waiting for the
-- lock or 60 s building, rather than stall post creation without bound; run the
-- backfill script (which builds it concurrently) and deploy again.
SELECT set_config('mention.variant_created_idx_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.variant_created_idx_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "post_content_variants_post_created_at_idx" ON "post_content_variants" USING btree ("post_created_at");
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.variant_created_idx_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.variant_created_idx_statement_timeout'), true);
