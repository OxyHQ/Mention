-- oxy:deploy-phase=pre
-- `posts` is hot, so these are alone in their file. They keep
-- `post_engagement_ranks` (0141) in step with `posts` inside the writing
-- transaction; nothing here copies existing rows.
--
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on `posts` until commit: it waits
-- for in-flight writes and holds new ones for the few milliseconds the catalog
-- change takes, under the migrator's 3 s lock_timeout (a lost race is retried).
--
-- Which writes fire them, and why that is cheap:
--  - INSERT only for a post that is listed on arrival (public, published, rank
--    not 0). A new post has no engagement, so ingest skips it in the WHEN.
--  - UPDATE OF the columns that decide membership, the key or the two prefilter
--    columns (is_reply, languages), and only when one of them really changed AND
--    the post is listed before or after. A like on a
--    listed post rewrites one narrow row; a write that repeats unchanged values
--    (the whole-row update paths) or touches a rank-0 private post fires nothing.
--  - DELETE only for a post that had a row.
--  - TRUNCATE empties the table with `posts`.
--
-- `scripts/backfillPostEngagementRanks.ts` copies the posts that existed before
-- this migration, after it, in short id-range batches; the triggers keep
-- everything written from here on current, so the copy never overwrites a row
-- (`ON CONFLICT DO NOTHING`). Readers stay on `posts_engagement_rank_idx` until
-- that copy has run and verified (`FEED_ENGAGEMENT_RANKS=on`).
CREATE TRIGGER "posts_engagement_rank_insert"
AFTER INSERT ON "posts"
FOR EACH ROW
WHEN (
  NEW.visibility = 'public' AND NEW.status = 'published'
  AND post_engagement_rank(NEW.stats_likes_count, NEW.stats_reposts_count,
    NEW.stats_federated_reposts_count, NEW.stats_comments_count) <> 0
)
EXECUTE FUNCTION "post_engagement_ranks_sync"();
--> statement-breakpoint
-- `UPDATE OF` fires when a column is in the SET list; the WHEN narrows that to a
-- real change of the key or of membership, for a post that is listed on either
-- side of the write.
CREATE TRIGGER "posts_engagement_rank_update"
AFTER UPDATE OF "id", "visibility", "status", "created_at", "is_reply", "classification_languages", "translated_languages", "stats_likes_count", "stats_reposts_count", "stats_federated_reposts_count", "stats_comments_count" ON "posts"
FOR EACH ROW
WHEN (
  (OLD.id, OLD.visibility, OLD.status, OLD.created_at, OLD.is_reply,
    OLD.classification_languages, OLD.translated_languages,
    post_engagement_rank(OLD.stats_likes_count, OLD.stats_reposts_count,
      OLD.stats_federated_reposts_count, OLD.stats_comments_count))
  IS DISTINCT FROM
  (NEW.id, NEW.visibility, NEW.status, NEW.created_at, NEW.is_reply,
    NEW.classification_languages, NEW.translated_languages,
    post_engagement_rank(NEW.stats_likes_count, NEW.stats_reposts_count,
      NEW.stats_federated_reposts_count, NEW.stats_comments_count))
  AND (
    (OLD.visibility = 'public' AND OLD.status = 'published'
      AND post_engagement_rank(OLD.stats_likes_count, OLD.stats_reposts_count,
        OLD.stats_federated_reposts_count, OLD.stats_comments_count) <> 0)
    OR (NEW.visibility = 'public' AND NEW.status = 'published'
      AND post_engagement_rank(NEW.stats_likes_count, NEW.stats_reposts_count,
        NEW.stats_federated_reposts_count, NEW.stats_comments_count) <> 0)
  )
)
EXECUTE FUNCTION "post_engagement_ranks_sync"();
--> statement-breakpoint
CREATE TRIGGER "posts_engagement_rank_delete"
AFTER DELETE ON "posts"
FOR EACH ROW
WHEN (
  OLD.visibility = 'public' AND OLD.status = 'published'
  AND post_engagement_rank(OLD.stats_likes_count, OLD.stats_reposts_count,
    OLD.stats_federated_reposts_count, OLD.stats_comments_count) <> 0
)
EXECUTE FUNCTION "post_engagement_ranks_sync"();
--> statement-breakpoint
CREATE TRIGGER "posts_engagement_rank_truncate"
AFTER TRUNCATE ON "posts"
FOR EACH STATEMENT
EXECUTE FUNCTION "post_engagement_ranks_truncate"();
