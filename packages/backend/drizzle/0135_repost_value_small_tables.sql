-- oxy:deploy-phase=pre
-- The stored value 'boost' is being renamed to 'repost' (docs/repost-rename.md). First release: every
-- CHECK learns the new value beside the old one (NOT VALID here, validated in 0139), and the two
-- trigger functions that hardcode 'boost' accept both. Nothing writes 'repost' yet.
ALTER TABLE "feed_interactions" DROP CONSTRAINT "feed_interactions_event_check";--> statement-breakpoint
ALTER TABLE "feed_interactions" ADD CONSTRAINT "feed_interactions_event_check" CHECK ("feed_interactions"."event" in ('impression', 'click', 'like', 'reply', 'boost', 'repost', 'save', 'report')) NOT VALID;--> statement-breakpoint
ALTER TABLE "federation_post_import_reasons" DROP CONSTRAINT "federation_post_import_reasons_reason_check";--> statement-breakpoint
ALTER TABLE "federation_post_import_reasons" ADD CONSTRAINT "federation_post_import_reasons_reason_check" CHECK ("federation_post_import_reasons"."reason" in ('discovery_backfill', 'followed_outbox', 'requested_profile', 'inbox_follow', 'inbox_mention', 'inbox_community', 'inbox_announce', 'boost_dependency', 'repost_dependency', 'quote_dependency', 'reply_dependency', 'unknown_outbox')) NOT VALID;--> statement-breakpoint
ALTER TABLE "federation_post_imports" DROP CONSTRAINT "federation_post_imports_reason_check";--> statement-breakpoint
ALTER TABLE "federation_post_imports" ADD CONSTRAINT "federation_post_imports_reason_check" CHECK ("federation_post_imports"."initial_reason" in ('discovery_backfill', 'followed_outbox', 'requested_profile', 'inbox_follow', 'inbox_mention', 'inbox_community', 'inbox_announce', 'boost_dependency', 'repost_dependency', 'quote_dependency', 'reply_dependency', 'unknown_outbox')) NOT VALID;
--> statement-breakpoint
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
        reposts_count = reposts_count - (OLD.type IN ('boost', 'repost'))::int
    WHERE oxy_user_id = OLD.oxy_user_id;
  END IF;
  IF TG_OP <> 'DELETE'
    AND NEW.oxy_user_id IS NOT NULL
    AND NEW.visibility = 'public'
    AND NEW.status = 'published'
    AND NEW.crosspost_collapsed IS NOT TRUE
  THEN
    INSERT INTO author_post_counts AS counts (oxy_user_id, posts_count, replies_count, reposts_count)
    VALUES (NEW.oxy_user_id, (NOT NEW.is_reply)::int, NEW.is_reply::int, (NEW.type IN ('boost', 'repost'))::int)
    ON CONFLICT (oxy_user_id) DO UPDATE
      SET posts_count = counts.posts_count + EXCLUDED.posts_count,
          replies_count = counts.replies_count + EXCLUDED.replies_count,
          reposts_count = counts.reposts_count + EXCLUDED.reposts_count;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "topic_affinity_posts_sync"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.visibility = 'public'
    AND NEW.status = 'published'
    AND NEW.type NOT IN ('boost', 'repost')
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
