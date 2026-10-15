-- `topic_affinity_posts`, maintained on write instead of refreshed.
--
-- 0065 made it a materialized view that `TopicAffinityRefreshJob` refreshed
-- CONCURRENTLY every five minutes. A concurrent refresh recomputes the whole
-- 30-day window (~22k rows) into a temporary table, then full-joins it against
-- the previous contents to find what changed, and applies that diff: the cost
-- of the whole window, every run, to move the few dozen rows a five-minute slice
-- of posting and classification actually changes. In production that was 289
-- slow-query entries a day, average 3.8 s, max 33 s (2026-10-14), on the shared
-- 2-vCPU instance — while the query defining the view, by itself, ran in 52 ms
-- (index-only on 0064's index; the cost was the refresh machinery).
--
-- Now a plain table with the same columns. The triggers below keep it in step
-- with `posts` in the transaction that changes a post, `ON DELETE CASCADE`
-- removes a deleted post's row, and the expiry sweep (`db/expiry.ts`) deletes
-- rows past the window. Each write costs one primary-key upsert or delete, and
-- only when an eligibility column actually changed: the engagement counters that
-- rewrite `posts` all day are not in the column list, so they never fire it.
--
-- The eligibility predicate is the view's, column for column. The `30 days` is
-- `TOPIC_AFFINITY_WINDOW_DAYS` (`db/schema/discovery.ts`); the reader applies
-- its own window, so the trigger's copy only keeps a reclassified OLD post from
-- being written in for the sweep to remove.
--
-- Bounded like 0064/0065: refuse after 5s acquiring locks or 60s running rather
-- than stall writes to `posts`. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on
-- `posts`, which holds writers off until this transaction commits; that is what
-- makes the copy below complete — no post can change between the copy's snapshot
-- and the moment the triggers start seeing writes. The copy reads 0064's index
-- (52 ms in production) and writes ~22k narrow rows.
SELECT set_config('mention.topic_affinity_sync_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.topic_affinity_sync_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
DROP MATERIALIZED VIEW "public"."topic_affinity_posts";
--> statement-breakpoint
CREATE TABLE "topic_affinity_posts" (
	"post_id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"topics" text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "topic_affinity_posts" ADD CONSTRAINT "topic_affinity_posts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "topic_affinity_posts_recent_idx" ON "topic_affinity_posts" USING btree ("created_at" DESC NULLS LAST,"post_id" DESC NULLS LAST);
--> statement-breakpoint
-- Upsert the post's row when it is eligible, delete it when it no longer is.
-- An INSERT that is not eligible has no row to delete, so only UPDATE deletes.
CREATE FUNCTION "topic_affinity_posts_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.visibility = 'public'
    AND NEW.status = 'published'
    AND NEW.type <> 'boost'
    AND NEW.oxy_user_id IS NOT NULL
    AND cardinality(NEW.classification_topics) > 0
    AND NEW.created_at >= now() - interval '30 days'
  THEN
    INSERT INTO topic_affinity_posts (post_id, oxy_user_id, created_at, topics)
    VALUES (NEW.id, NEW.oxy_user_id, NEW.created_at, NEW.classification_topics)
    ON CONFLICT (post_id) DO UPDATE
      SET oxy_user_id = EXCLUDED.oxy_user_id,
          created_at = EXCLUDED.created_at,
          topics = EXCLUDED.topics;
  ELSIF TG_OP = 'UPDATE' THEN
    DELETE FROM topic_affinity_posts WHERE post_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- A new post is classified later, so nearly every INSERT carries no topics and
-- the WHEN keeps it from queueing a trigger call at all.
CREATE TRIGGER "posts_topic_affinity_insert"
AFTER INSERT ON "posts"
FOR EACH ROW
WHEN (cardinality(NEW.classification_topics) > 0)
EXECUTE FUNCTION "topic_affinity_posts_sync"();
--> statement-breakpoint
-- `UPDATE OF` fires when a column is in the SET list; the WHEN narrows that to a
-- real change, since a whole-row write repeats columns it did not change.
CREATE TRIGGER "posts_topic_affinity_update"
AFTER UPDATE OF "visibility", "status", "type", "oxy_user_id", "classification_topics", "created_at" ON "posts"
FOR EACH ROW
WHEN (
  (OLD.visibility, OLD.status, OLD.type, OLD.oxy_user_id, OLD.classification_topics, OLD.created_at)
  IS DISTINCT FROM
  (NEW.visibility, NEW.status, NEW.type, NEW.oxy_user_id, NEW.classification_topics, NEW.created_at)
)
EXECUTE FUNCTION "topic_affinity_posts_sync"();
--> statement-breakpoint
INSERT INTO "topic_affinity_posts" ("post_id", "oxy_user_id", "created_at", "topics")
SELECT "id", "oxy_user_id", "created_at", "classification_topics"
FROM "posts"
WHERE "visibility" = 'public'
  AND "status" = 'published'
  AND "type" <> 'boost'
  AND "oxy_user_id" IS NOT NULL
  AND cardinality("classification_topics") > 0
  AND "created_at" >= now() - interval '30 days';
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.topic_affinity_sync_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.topic_affinity_sync_statement_timeout'), true);
