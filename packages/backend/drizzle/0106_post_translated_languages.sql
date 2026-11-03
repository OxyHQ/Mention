-- oxy:deploy-phase=pre
-- The base languages a post has a machine translation in (`post_content_variants`
-- rows with source = 'machine'), so the feed's reader-language gate admits a post
-- translated into the reader's language. A nullable column with no default is a
-- catalogue-only change; the backfill and its index follow in 0107.
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "translated_languages" text[];
