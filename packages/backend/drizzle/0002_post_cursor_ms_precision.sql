ALTER TABLE "articles" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "gifs" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "gifs" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "push_tokens" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "push_tokens" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "topic_stats" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "topic_stats" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "trending" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "bookmarks" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "bookmarks" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "entity_follows" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "entity_follows" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "likes" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "likes" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "mute_words" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "mute_words" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "mutes" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "pokes" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "post_subscriptions" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "post_subscriptions" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "actor_key_pairs" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "actor_key_pairs" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "federated_actors" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "federated_actors" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "federated_follows" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "federated_follows" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "federated_media_cache" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "federated_media_cache" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "federation_delivery_queue" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "federation_delivery_queue" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "custom_feeds" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "custom_feeds" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "feed_generators" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "feed_generators" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "feed_interactions" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "feed_interactions" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "feed_likes" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "feed_likes" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "feed_reviews" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "feed_reviews" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_feed_preferences" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_feed_preferences" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "postgates" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "postgates" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "threadgates" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "threadgates" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "account_lists" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "account_lists" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "starter_pack_uses" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "starter_packs" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "starter_packs" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "content_labels" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "content_labels" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "labelers" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "labelers" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "moderation_enforcements" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "moderation_enforcements" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "moderation_events" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "moderation_events" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "moderation_outbox" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "moderation_outbox" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "mention_node_ingest_witnesses" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "mention_repo_heads" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "mention_repo_heads" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "mention_signed_records" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "mention_user_nodes" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "mention_user_nodes" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "endorsement_outbox" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "endorsement_outbox" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "engagement_outbox" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "engagement_outbox" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "post_recent_repliers" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "post_recent_repliers" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "poll_votes" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "polls" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "polls" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_behaviors" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_behaviors" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
-- Rows written by the previous `now()` default carry microseconds a JavaScript
-- `Date` cannot hold, which is what let a `(created_at, id)` keyset compare
-- against a value SMALLER than the row it came from. Normalising them is what
-- makes this fix retroactive rather than only forward-looking — and the CHECK
-- below would reject them otherwise.
--
-- `updated_at` moves with it so a row's two stamps keep the same precision;
-- this is raw SQL, so drizzle's client-side `$onUpdate` does not fire.
UPDATE "posts"
   SET "created_at" = date_trunc('milliseconds', "created_at"),
       "updated_at" = date_trunc('milliseconds', "updated_at")
 WHERE "created_at" <> date_trunc('milliseconds', "created_at")
    OR "updated_at" <> date_trunc('milliseconds', "updated_at");
--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_at_ms_precision_check" CHECK ("posts"."created_at" = date_trunc('milliseconds', "posts"."created_at"));