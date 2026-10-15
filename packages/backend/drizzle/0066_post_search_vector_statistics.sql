-- Statistics fine enough for the planner to tell a rare search word from a common one.
--
-- `GET /search?query=elevenlabs&type=posts` answered 503 (2026-10-15): the
-- oldest search window (`services/search/postSearch.ts`, everything before the
-- last month, 761k posts) ran into the 3 s statement_timeout. The planner
-- estimates a word's matches from the most-common-lexeme list ANALYZE keeps
-- for `search_vector`, and a word missing from that list gets half the list's
-- smallest frequency. At the default statistics target (100) the list holds
-- 1,000 lexemes and its smallest frequency is 0.003, so every word rarer than
-- ~4,800 renditions was estimated at ~2,400. "elevenlabs" matches 30. Believing
-- 2,400, the planner walked `posts` newest-first expecting a match every few
-- hundred rows and read the whole window instead.
--
-- At 1000 the list holds 10,000 lexemes, the smallest frequency falls to ~2e-4
-- (measured on a 5% sample in production) and a word outside it is estimated
-- at ~160. At that estimate the planner reads the matches from the GIN index
-- and their posts by primary key (EXPLAIN in production, an AND of two
-- in-list lexemes estimated at 147). Higher buys little and costs planning
-- time: every search plan reads the whole list.
--
-- ANALYZE now, rather than at the next autoanalyze (days away at this table's
-- write rate), so the estimate is right from this deploy. It reads at most the
-- table's 141k pages and takes only SHARE UPDATE EXCLUSIVE, which blocks no
-- read or write. Bounded like 0065: refuse after 5s acquiring the lock or 180s
-- running rather than hold the deploy.
SELECT set_config('mention.post_search_statistics_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.post_search_statistics_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '180s';
--> statement-breakpoint
ALTER TABLE "post_content_variants" ALTER COLUMN "search_vector" SET STATISTICS 1000;
--> statement-breakpoint
ANALYZE "post_content_variants" ("search_vector");
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.post_search_statistics_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.post_search_statistics_statement_timeout'), true);
