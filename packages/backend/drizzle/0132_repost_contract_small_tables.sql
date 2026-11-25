-- oxy:deploy-phase=post
-- CONTRACT phase of the boost -> repost rename, for the smaller tables (docs/repost-rename.md).
-- Nothing reads or writes the old columns any more (the switch shipped a release ago and the
-- old pods are gone), and every pair was verified equal before this was merged. The old
-- columns drop with their CHECKs (the new ones were added and validated in 0130/0131). The
-- counter trigger of author_post_counts is the one place that still wrote the old column,
-- so it is replaced first.
CREATE OR REPLACE FUNCTION "author_post_counts_apply"() RETURNS trigger LANGUAGE plpgsql AS $$
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
        reposts_count = reposts_count - (OLD.type = 'boost')::int
    WHERE oxy_user_id = OLD.oxy_user_id;
  END IF;
  IF TG_OP <> 'DELETE'
    AND NEW.oxy_user_id IS NOT NULL
    AND NEW.visibility = 'public'
    AND NEW.status = 'published'
    AND NEW.crosspost_collapsed IS NOT TRUE
  THEN
    INSERT INTO author_post_counts AS counts (oxy_user_id, posts_count, replies_count, reposts_count)
    VALUES (NEW.oxy_user_id, (NOT NEW.is_reply)::int, NEW.is_reply::int, (NEW.type = 'boost')::int)
    ON CONFLICT (oxy_user_id) DO UPDATE
      SET posts_count = counts.posts_count + EXCLUDED.posts_count,
          replies_count = counts.replies_count + EXCLUDED.replies_count,
          reposts_count = counts.reposts_count + EXCLUDED.reposts_count;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER "author_post_counts_sync_repost_columns" ON "author_post_counts";--> statement-breakpoint
DROP TRIGGER "user_behavior_authors_sync_repost_columns" ON "user_behavior_authors";--> statement-breakpoint
DROP TRIGGER "custom_feeds_sync_repost_columns" ON "custom_feeds";--> statement-breakpoint
DROP TRIGGER "blocked_domain_purge_runs_sync_repost_columns" ON "blocked_domain_purge_runs";--> statement-breakpoint
DROP TRIGGER "blocked_domain_purges_sync_repost_columns" ON "blocked_domain_purges";--> statement-breakpoint
DROP FUNCTION "author_post_counts_sync_repost_columns"();--> statement-breakpoint
DROP FUNCTION "user_behavior_authors_sync_repost_columns"();--> statement-breakpoint
DROP FUNCTION "custom_feeds_sync_repost_columns"();--> statement-breakpoint
DROP FUNCTION "blocked_domain_purge_runs_sync_repost_columns"();--> statement-breakpoint
DROP FUNCTION "blocked_domain_purges_sync_repost_columns"();--> statement-breakpoint
ALTER TABLE "author_post_counts" DROP COLUMN "boosts_count";--> statement-breakpoint
ALTER TABLE "user_behavior_authors" DROP COLUMN "boosts";--> statement-breakpoint
ALTER TABLE "custom_feeds" DROP COLUMN "include_boosts";--> statement-breakpoint
ALTER TABLE "blocked_domain_purge_runs" DROP COLUMN "removed_boosts";--> statement-breakpoint
ALTER TABLE "blocked_domain_purge_runs" ALTER COLUMN "removed_reposts" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "blocked_domain_purges" DROP COLUMN "measured_boosts";
