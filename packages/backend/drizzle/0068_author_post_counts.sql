-- oxy:deploy-phase=pre
-- `author_post_counts`: an author's public post counts, maintained on write.
--
-- The profile page (`GET /profile/design/:userId`) and a profile's structured
-- data (the web shell's `/@handle`) show three numbers that
-- `countAuthorPublicPosts` computed per request: one `count(*) filter (...)`
-- pass over the author's public, published, uncollapsed posts. The index found
-- those rows, but the buckets (`is_reply`, `type`) and `crosspost_collapsed`
-- live on the heap, and an author's posts are scattered across it, so the count
-- read one heap page per post: 2,567 heap pages for a 2,747-post author, 6.4 s
-- cold (EXPLAIN ANALYZE, production, 2026-10-15). The slow-query log had it
-- 1,295-1,351 times a day, average 515 ms, max 3.7 s. A covering index would
-- not have fixed it: a third of `posts` pages are not all-visible (the
-- engagement counters keep rewriting them), and an index-only count over the
-- author index still made 781 heap fetches for that author.
--
-- Now one row per author, read by primary key. The triggers below add a post's
-- contribution when it enters the counted set and subtract it when it leaves,
-- in the writing transaction: an INSERT or DELETE of a counted post, and an
-- UPDATE that actually changes one of the six columns the count reads. The
-- engagement counters are not among them, so the writes that rewrite `posts`
-- all day never fire it. Boosts deleted by the `boost_of` cascade fire the
-- DELETE trigger like any other delete.
--
-- The counted set is the old query's predicate, column for column:
-- `oxy_user_id IS NOT NULL AND visibility = 'public' AND status = 'published'
-- AND crosspost_collapsed IS NOT TRUE`, bucketed by `is_reply` and
-- `type = 'boost'`.
--
-- A subtraction is a plain UPDATE, never an upsert: every counted post already
-- has its author's row (the copy below, or the addition that counted it), so a
-- subtraction never needs to create one. It also means that once account
-- erasure has deleted an author's row, nothing can recreate it.
--
-- Bounded like 0064/0065: refuse after 5s acquiring locks or 60s running rather
-- than stall writes to `posts`. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on
-- `posts` and holds writers off until this transaction commits. That is what
-- makes the copy below exact: no post can change between the copy's snapshot and
-- the moment the triggers start seeing writes. The copy is one parallel scan of
-- `posts`: 1.8 s for 106,553 authors in production (EXPLAIN ANALYZE, 2026-10-15).
SELECT set_config('mention.author_post_counts_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.author_post_counts_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE TABLE "author_post_counts" (
	"oxy_user_id" text PRIMARY KEY NOT NULL,
	"posts_count" integer DEFAULT 0 NOT NULL,
	"replies_count" integer DEFAULT 0 NOT NULL,
	"boosts_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE FUNCTION "author_post_counts_apply"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT'
    AND OLD.oxy_user_id IS NOT NULL
    AND OLD.visibility = 'public'
    AND OLD.status = 'published'
    AND OLD.crosspost_collapsed IS NOT TRUE
  THEN
    UPDATE author_post_counts
    SET posts_count = posts_count - (NOT OLD.is_reply)::int,
        replies_count = replies_count - OLD.is_reply::int,
        boosts_count = boosts_count - (OLD.type = 'boost')::int
    WHERE oxy_user_id = OLD.oxy_user_id;
  END IF;
  IF TG_OP <> 'DELETE'
    AND NEW.oxy_user_id IS NOT NULL
    AND NEW.visibility = 'public'
    AND NEW.status = 'published'
    AND NEW.crosspost_collapsed IS NOT TRUE
  THEN
    INSERT INTO author_post_counts AS counts (oxy_user_id, posts_count, replies_count, boosts_count)
    VALUES (NEW.oxy_user_id, (NOT NEW.is_reply)::int, NEW.is_reply::int, (NEW.type = 'boost')::int)
    ON CONFLICT (oxy_user_id) DO UPDATE
      SET posts_count = counts.posts_count + EXCLUDED.posts_count,
          replies_count = counts.replies_count + EXCLUDED.replies_count,
          boosts_count = counts.boosts_count + EXCLUDED.boosts_count;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "posts_author_counts_insert"
AFTER INSERT ON "posts"
FOR EACH ROW
WHEN (
  NEW.oxy_user_id IS NOT NULL
  AND NEW.visibility = 'public'
  AND NEW.status = 'published'
  AND NEW.crosspost_collapsed IS NOT TRUE
)
EXECUTE FUNCTION "author_post_counts_apply"();
--> statement-breakpoint
CREATE TRIGGER "posts_author_counts_delete"
AFTER DELETE ON "posts"
FOR EACH ROW
WHEN (
  OLD.oxy_user_id IS NOT NULL
  AND OLD.visibility = 'public'
  AND OLD.status = 'published'
  AND OLD.crosspost_collapsed IS NOT TRUE
)
EXECUTE FUNCTION "author_post_counts_apply"();
--> statement-breakpoint
-- `UPDATE OF` fires when a column is in the SET list; the WHEN narrows that to a
-- real change, since a whole-row write repeats columns it did not change.
CREATE TRIGGER "posts_author_counts_update"
AFTER UPDATE OF "oxy_user_id", "visibility", "status", "crosspost_collapsed", "is_reply", "type" ON "posts"
FOR EACH ROW
WHEN (
  (OLD.oxy_user_id, OLD.visibility, OLD.status, OLD.crosspost_collapsed, OLD.is_reply, OLD.type)
  IS DISTINCT FROM
  (NEW.oxy_user_id, NEW.visibility, NEW.status, NEW.crosspost_collapsed, NEW.is_reply, NEW.type)
)
EXECUTE FUNCTION "author_post_counts_apply"();
--> statement-breakpoint
INSERT INTO "author_post_counts" ("oxy_user_id", "posts_count", "replies_count", "boosts_count")
SELECT "oxy_user_id",
       count(*) FILTER (WHERE NOT "is_reply"),
       count(*) FILTER (WHERE "is_reply"),
       count(*) FILTER (WHERE "type" = 'boost')
FROM "posts"
WHERE "oxy_user_id" IS NOT NULL
  AND "visibility" = 'public'
  AND "status" = 'published'
  AND "crosspost_collapsed" IS NOT TRUE
GROUP BY "oxy_user_id";
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.author_post_counts_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.author_post_counts_statement_timeout'), true);
