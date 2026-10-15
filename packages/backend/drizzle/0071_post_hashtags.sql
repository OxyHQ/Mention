-- `post_hashtags`: the newest public posts per hashtag, maintained on write.
--
-- `GET /posts/hashtag/:hashtag` (p99 4.2 s, max 9.9 s on 2026-10-14, database
-- time 3.2 s at p99) asks for the newest public posts carrying one tag. The GIN
-- index on `posts.hashtags` finds every post with the tag but cannot order
-- them, so production picked between two scans (EXPLAIN ANALYZE, 2026-10-15):
-- a common tag (`opensource`) walked `post_public_chrono_v1` filtering
-- `hashtags @>`, reading 17,881 rows and 18k buffers to keep 21 (1.1 s cold);
-- a less common one (`dogsofmastodon`) fetched all 1,061 matching heap pages
-- and sorted them (0.73 s cold). A row per (post, tag) with an index on
-- (tag, created_at desc, post_id desc) turns a page into one index range of the
-- page's own length.
--
-- The triggers below keep it in step with `posts` in the writing transaction.
-- An INSERT with hashtags adds the post's rows. An UPDATE that actually changes
-- the tags, the visibility, the status, the crosspost collapse or `created_at`
-- rewrites them: delete, then insert again when the post is still listed.
-- Deletes go with `ON DELETE CASCADE`. The engagement counters are not in the
-- column list, so they never fire it. Listed means the hashtag page's filter:
-- public, published, and not a collapsed crosspost variant.
--
-- No copy of existing posts here. 425k public posts carry 1.5M (post, tag)
-- pairs, and copying them inside this transaction would hold writes to `posts`
-- off (CREATE TRIGGER takes SHARE ROW EXCLUSIVE until commit) for a sequential
-- scan of the table plus 1.5M inserts and two index builds, an estimated
-- 10-15 s on the production instance. `scripts/backfillPostHashtags.ts` copies
-- them afterwards in short batches that lock only the rows they copy, while the
-- triggers keep everything written since this migration current. Readers move
-- to the table once that copy has run.
--
-- CREATE TRIGGER waits for in-flight writes to `posts`; refuse after 5 s rather
-- than queue every later write behind it.
SELECT set_config('mention.post_hashtags_lock_timeout', current_setting('lock_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "post_hashtags" (
	"post_id" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "post_hashtags_pkey" PRIMARY KEY("post_id","tag")
);
--> statement-breakpoint
ALTER TABLE "post_hashtags" ADD CONSTRAINT "post_hashtags_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "post_hashtags_tag_recent_idx" ON "post_hashtags" USING btree ("tag","created_at" DESC NULLS LAST,"post_id" DESC NULLS LAST);
--> statement-breakpoint
CREATE FUNCTION "post_hashtags_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM post_hashtags WHERE post_id = NEW.id;
  END IF;
  IF NEW.visibility = 'public'
    AND NEW.status = 'published'
    AND NEW.crosspost_collapsed IS NOT TRUE
    AND cardinality(NEW.hashtags) > 0
  THEN
    INSERT INTO post_hashtags (post_id, tag, created_at)
    SELECT DISTINCT NEW.id, tag, NEW.created_at
    FROM unnest(NEW.hashtags) AS tag
    WHERE tag IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "posts_hashtags_insert"
AFTER INSERT ON "posts"
FOR EACH ROW
WHEN (cardinality(NEW.hashtags) > 0)
EXECUTE FUNCTION "post_hashtags_sync"();
--> statement-breakpoint
-- `UPDATE OF` fires when a column is in the SET list; the WHEN narrows that to a
-- real change, since a whole-row write repeats columns it did not change.
CREATE TRIGGER "posts_hashtags_update"
AFTER UPDATE OF "hashtags", "visibility", "status", "crosspost_collapsed", "created_at" ON "posts"
FOR EACH ROW
WHEN (
  (OLD.hashtags, OLD.visibility, OLD.status, OLD.crosspost_collapsed, OLD.created_at)
  IS DISTINCT FROM
  (NEW.hashtags, NEW.visibility, NEW.status, NEW.crosspost_collapsed, NEW.created_at)
)
EXECUTE FUNCTION "post_hashtags_sync"();
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.post_hashtags_lock_timeout'), true);
