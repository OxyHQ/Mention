-- oxy:deploy-phase=pre
-- posts is hot, so alone in its file. Two AFTER UPDATE triggers fire when `type` changes and, for the
-- rename of the stored value 'boost' -> 'repost' (docs/repost-rename.md), that change is a net zero for
-- both: the per-author counter counts either name as a repost and the topic-affinity function treats
-- either as "not a post to index". Fired anyway, each of the 3.4M renamed rows cost two counter upserts
-- (contended between runs, hence deadlocks) and a delete. The WHEN now compares "is a repost" instead of
-- the raw value, so only a change that matters fires them; every other condition is untouched.
DROP TRIGGER "posts_author_counts_update" ON "posts";--> statement-breakpoint
CREATE TRIGGER "posts_author_counts_update" AFTER UPDATE OF oxy_user_id, visibility, status, crosspost_collapsed, is_reply, type ON "posts" FOR EACH ROW WHEN (((((((old.oxy_user_id IS DISTINCT FROM new.oxy_user_id) OR (old.visibility IS DISTINCT FROM new.visibility)) OR (old.status IS DISTINCT FROM new.status)) OR (old.crosspost_collapsed IS DISTINCT FROM new.crosspost_collapsed)) OR (old.is_reply IS DISTINCT FROM new.is_reply)) OR ((old.type = ANY (ARRAY['boost'::text, 'repost'::text])) IS DISTINCT FROM (new.type = ANY (ARRAY['boost'::text, 'repost'::text]))))) EXECUTE FUNCTION "author_post_counts_apply"();
--> statement-breakpoint
DROP TRIGGER "posts_topic_affinity_update" ON "posts";--> statement-breakpoint
CREATE TRIGGER "posts_topic_affinity_update" AFTER UPDATE OF visibility, status, type, oxy_user_id, classification_topics, created_at ON "posts" FOR EACH ROW WHEN (((((((old.visibility IS DISTINCT FROM new.visibility) OR (old.status IS DISTINCT FROM new.status)) OR ((old.type = ANY (ARRAY['boost'::text, 'repost'::text])) IS DISTINCT FROM (new.type = ANY (ARRAY['boost'::text, 'repost'::text])))) OR (old.oxy_user_id IS DISTINCT FROM new.oxy_user_id)) OR (old.classification_topics IS DISTINCT FROM new.classification_topics)) OR (old.created_at IS DISTINCT FROM new.created_at))) EXECUTE FUNCTION "topic_affinity_posts_sync"();
