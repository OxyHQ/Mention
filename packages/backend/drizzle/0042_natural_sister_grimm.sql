-- Three trigram indexes so list, feed and starter-pack search stops scanning.
--
-- Each of those listings matched with `ILIKE '%term%'` over its text columns
-- and had NO index that could serve it — a substring match is answerable by
-- neither a b-tree nor a `tsvector`. So every search of the Lists, Feeds and
-- Starter Packs lanes was a sequential scan of the whole table, and the search
-- screen fired all three at once. `GET /feeds` is worse than the others: the
-- home tab calls it on mount too.
--
-- Each index is over the CONCATENATION of that table's searched columns, which
-- lets the query add a coarse prefilter against the same expression and keep
-- its own exact `ILIKE`s as the recheck. A substring of any one column is a
-- substring of the concatenation, so the prefilter can only ever admit MORE
-- rows than the real answer (a match spanning a column boundary), never fewer.
-- One index and one bitmap scan per table instead of a `BitmapOr` over two or
-- three, and one set of write-time maintenance. This is the idiom
-- `posts_hashtags_trgm_gin` established in 0038.
--
-- WHY ONLY `custom_feeds` GETS A FUNCTION. `keywords` is `text[]`, and folding
-- it into the expression needs `array_to_string`, which Postgres classifies
-- STABLE — and a STABLE function cannot appear in an index expression. The
-- wrapper is the same measured workaround `posts_hashtags_search_text` exists
-- for (0038 records the reasoning); marking it IMMUTABLE is honest because
-- joining already-lowercased text with a fixed ASCII space is deterministic for
-- every input these columns hold. `account_lists` and `starter_packs` index
-- plain `text` columns, and `lower` / `coalesce` / `||` are all IMMUTABLE
-- already, so inventing functions for them would be ceremony.
--
-- `CREATE OR REPLACE`, so this migration is re-runnable, and the function is
-- referenced by `routes/customFeeds.routes.ts` as well as by the index — the
-- query and the index agree on one expression by never restating it. Note the
-- obligation that creates: changing this function's body or volatility
-- INVALIDATES the index built on it, silently. `searchIndexes.test.ts` asserts
-- `pg_proc.provolatile = 'i'` for exactly that reason.
CREATE OR REPLACE FUNCTION custom_feeds_search_text(text, text, text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT lower(
    coalesce($1, '') || ' ' || coalesce($2, '') || ' ' || coalesce(array_to_string($3, ' '), '')
  )
$$;
--> statement-breakpoint
-- This uses the existing transactional migrator: CONCURRENTLY is unavailable.
-- CREATE INDEX takes SHARE: reads continue, writes wait until the transaction
-- commits. Refuse after 5s acquiring locks or 60s building, rather than create
-- an unbounded write stall. A failure rolls back the indexes and ledger entry.
-- All three tables are small and write-light — unlike `posts` in 0029 — so 60s
-- is generous rather than tight here.
-- Preserve the connection settings for any later migration in this transaction.
SELECT set_config('mention.search_trgm_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.search_trgm_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE INDEX "custom_feeds_search_trgm_gin" ON "custom_feeds" USING gin (custom_feeds_search_text("title", "description", "keywords") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "account_lists_search_trgm_gin" ON "account_lists" USING gin (lower(coalesce(title, '') || ' ' || coalesce(description, '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "starter_packs_search_trgm_gin" ON "starter_packs" USING gin (lower(coalesce(name, '') || ' ' || coalesce(description, '')) gin_trgm_ops);
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.search_trgm_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.search_trgm_statement_timeout'), true);
