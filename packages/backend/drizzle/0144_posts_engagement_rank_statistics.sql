-- oxy:deploy-phase=pre
-- `posts` is hot, so this is alone in its file.
--
-- The planner's statistics on the engagement composite, kept when its index
-- goes. ANALYZE collects statistics for an expression index's expression, and
-- `posts_engagement_rank_idx` is today the only source of them. The banded
-- popular read (`db/posts/engagementRankScan.ts`) filters the rank-0 run with
-- `engagementRankSql(posts) = 0`, which holds for about 70% of public posts;
-- without statistics the planner assumes 0.5%. These extended statistics on the
-- same expression give it the real distribution with no index to maintain, so
-- they cost a counter bump nothing (statistics objects are not indexes and do
-- not affect HOT).
--
-- The expression is `engagementRankSql` as 0129 spells the index, so the planner
-- matches it to the query's. It is filled by the next ANALYZE of `posts`
-- (autovacuum, or by hand in the rollout before the expression index is
-- dropped). CREATE STATISTICS takes SHARE UPDATE EXCLUSIVE: reads and writes
-- continue.
CREATE STATISTICS IF NOT EXISTS "posts_engagement_rank_stats" ON ((
    "stats_likes_count" * 1::double precision
    + greatest(0, "stats_reposts_count" - "stats_federated_reposts_count") * 2.5::double precision
    + "stats_federated_reposts_count" * 0.5::double precision
    + "stats_comments_count" * 2::double precision
  )::double precision) FROM "posts";
