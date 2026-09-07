-- The popular/discovery scan's ORDER BY becomes index-satisfiable, so a page
-- costs a page instead of costing the archive.
--
-- WHY: `runPopular` (`mtn/feed/engine/sources/discoverySources.ts`) orders by a
-- COMPUTED engagement composite, then `created_at`, `id`. An expression is not a
-- column, so with nothing indexing it the planner has exactly one option — read
-- every candidate row and top-N sort them. The work is bounded by the TABLE and
-- the answer is 60 rows, so the cost grows with the archive forever.
--
-- It is reached through `fetchWithRecencyFallback`, whose final pass drops the
-- recency bound ENTIRELY so a sparse instance is never served a blank page. That
-- pass is the expensive one and it is NOT a rare corner: the windows are tested
-- after the viewer's language filter, so a reader whose languages are thinly
-- represented on the instance underfills 7d and 30d and reaches the unbounded
-- whole-table sort on every page they turn. Production logged it at 17.25s.
--
-- MEASURED on 275,000 posts (263,044 public+published), warm cache, page of 60:
--
--   window      before            after
--   7 days      20.3-28.0 ms      0.25-0.34 ms
--   30 days     50.5-53.3 ms      0.13-0.37 ms
--   unbounded   77.4-89.0 ms      0.11-0.26 ms
--
-- and the unbounded scan goes from ~11,600 buffers to 63. The ratio is not the
-- point; the SHAPE is. After this the scan stops at the page, so it no longer
-- grows with the corpus, which is the only property that survives production
-- being far larger than any bench.
--
-- The WRITE side was measured rather than assumed, because these are four of the
-- hottest counters in the schema: 20,000 counter increments took 737-844 ms with
-- the index and 764-935 ms without — no difference this bench can resolve.
--
-- PARTIAL on the `visibility`/`status` pair every one of these scans fixes, which
-- keeps it the size of the servable set.
--
-- The expression is generated from `engagementRankSql` (`db/schema/posts.ts`),
-- the same function the query calls, because Postgres matches an expression index
-- by comparing PARSED expressions: spelled twice, the two agree until the first
-- weight change and then silently stop matching, and the only symptom is the slow
-- plan coming back. `src/__tests__/db/engagementRankIndex.test.ts` reads this
-- index back out of the catalogue and drives a real query onto it.

CREATE INDEX "posts_engagement_rank_idx" ON "posts" USING btree (((
    "stats_likes_count" * 1::double precision
    + greatest(0, "stats_boosts_count" - "stats_federated_boosts_count") * 2.5::double precision
    + "stats_federated_boosts_count" * 0.5::double precision
    + "stats_comments_count" * 2::double precision
  )::double precision) desc,"created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "posts"."visibility" = 'public' and "posts"."status" = 'published';