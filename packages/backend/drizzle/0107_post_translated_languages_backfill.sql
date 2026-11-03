-- oxy:deploy-phase=pre
-- Fill `translated_languages` from the machine renditions already stored.
-- Translations are made only on a reader's request, so few posts carry one; the
-- UPDATE touches only those rows.
--
-- The index is partial (`is not null`): it holds the translated posts only. Its
-- build still scans `posts` under SHARE (reads continue, writes wait). Optionally
-- pre-build it CONCURRENTLY by hand with the same name and definition; a failed
-- build leaves an INVALID index that IF NOT EXISTS skips, so check
-- `pg_index.indisvalid` first.
UPDATE "posts" AS p
SET "translated_languages" = t.languages
FROM (
  SELECT "post_id", array_agg(DISTINCT split_part(lower("tag"), '-', 1) ORDER BY split_part(lower("tag"), '-', 1)) AS languages
  FROM "post_content_variants"
  WHERE "source" = 'machine' AND "tag" IS NOT NULL
  GROUP BY "post_id"
) AS t
WHERE p."id" = t."post_id";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_translated_languages_gin" ON "posts" USING gin ("translated_languages") WHERE "posts"."translated_languages" is not null;
