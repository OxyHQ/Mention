-- PREREQUISITE: PostGIS must already be installed in this database, and the
-- application role CANNOT install it.
--
-- This file creates `posts.geo` and `posts.content_geo` as `geography` columns,
-- so on a database without PostGIS it fails here, at the first statement that
-- names the type:
--
--     ERROR:  type "geography" does not exist
--     LINE 66:  "content_geo" "geography" GENERATED ALWAYS AS (ST_MakePoint...
--
-- (measured 2026-08-03 by applying this file to a fresh database).
--
-- `src/db/extensions.ts` runs `create extension if not exists postgis` before
-- any migration, and `IF NOT EXISTS` short-circuits on the duplicate check
-- BEFORE the privilege check — which is what lets that step be a no-op for an
-- unprivileged role. It is not a fallback: on a database where PostGIS is
-- genuinely absent, the application role is REFUSED.
--
--     create extension postgis;
--     ERROR:  permission denied to create extension "postgis"
--
-- Measured 2026-08-03 against RDS as `mention` on a database `mention` OWNS
-- (reproduced twice). Ownership is not enough; PostGIS is not a trusted
-- extension, so it takes a role with `rds_superuser`.
--
-- So a NEW target database — disaster recovery, staging, another region — needs
-- one privileged statement before the migrator ever runs:
--
--     CREATE EXTENSION postgis;    -- as the master user, once, per database
--
-- Production satisfies this already: its `spatial_ref_sys` is owned by
-- `rdsadmin`, i.e. someone ran exactly that and it was never written down. This
-- header is where it is written down. See `src/db/MIGRATION-CONTRACT.md`.
CREATE TABLE "articles" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text,
	"created_by" text NOT NULL,
	"title" text,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "author_follower_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"follower_count" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "author_follower_snapshots_follower_count_check" CHECK ("author_follower_snapshots"."follower_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "gifs" (
	"id" text PRIMARY KEY NOT NULL,
	"klipy_id" text NOT NULL,
	"source" text DEFAULT 'klipy' NOT NULL,
	"slug" text DEFAULT '' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"search_terms" text[] DEFAULT array[]::text[] NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"mp4_file_id" text NOT NULL,
	"preview_file_id" text NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"search_hit_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(array_to_tsvector(search_terms), 'A')
        || setweight(to_tsvector('simple', title), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gifs_klipy_id_key" UNIQUE("klipy_id"),
	CONSTRAINT "gifs_source_check" CHECK ("gifs"."source" in ('klipy')),
	CONSTRAINT "gifs_dimensions_check" CHECK ("gifs"."width" > 0 and "gifs"."height" > 0),
	CONSTRAINT "gifs_counts_check" CHECK ("gifs"."use_count" >= 0 and "gifs"."search_hit_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"type" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedup_key" UNIQUE("recipient_id","actor_id","type","entity_id"),
	CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('like', 'reply', 'mention', 'follow', 'boost', 'quote', 'welcome', 'post', 'poke', 'collab_invite', 'collab_accepted', 'collab_declined')),
	CONSTRAINT "notifications_entity_type_check" CHECK ("notifications"."entity_type" in ('post', 'reply', 'profile'))
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"type" text DEFAULT 'unknown' NOT NULL,
	"platform" text DEFAULT 'unknown' NOT NULL,
	"device_id" text,
	"locale" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_token_key" UNIQUE("token"),
	CONSTRAINT "push_tokens_type_check" CHECK ("push_tokens"."type" in ('fcm', 'apns', 'unknown')),
	CONSTRAINT "push_tokens_platform_check" CHECK ("push_tokens"."platform" in ('android', 'ios', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "topic_stats" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"popularity" double precision DEFAULT 0 NOT NULL,
	"post_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_stats_topic_id_key" UNIQUE("topic_id"),
	CONSTRAINT "topic_stats_post_count_check" CHECK ("topic_stats"."post_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "trend_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"calculated_at" timestamp with time zone NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	CONSTRAINT "trend_batches_calculated_at_key" UNIQUE("calculated_at")
);
--> statement-breakpoint
CREATE TABLE "trending" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"score" double precision NOT NULL,
	"volume" integer DEFAULT 0 NOT NULL,
	"momentum" double precision DEFAULT 0 NOT NULL,
	"rank" integer NOT NULL,
	"topic_id" text,
	"calculated_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trending_name_calculated_at_type_key" UNIQUE("name","calculated_at","type"),
	CONSTRAINT "trending_type_check" CHECK ("trending"."type" in ('hashtag', 'topic', 'entity')),
	CONSTRAINT "trending_volume_check" CHECK ("trending"."volume" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"post_id" text NOT NULL,
	"folder" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookmarks_user_id_post_id_key" UNIQUE("user_id","post_id")
);
--> statement-breakpoint
CREATE TABLE "entity_follows" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_follows_user_id_entity_type_entity_id_key" UNIQUE("user_id","entity_type","entity_id"),
	CONSTRAINT "entity_follows_entity_type_check" CHECK ("entity_follows"."entity_type" in ('hashtag', 'list'))
);
--> statement-breakpoint
CREATE TABLE "likes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"post_id" text NOT NULL,
	"value" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "likes_user_id_post_id_key" UNIQUE("user_id","post_id"),
	CONSTRAINT "likes_value_check" CHECK ("likes"."value" in (1, -1)),
	CONSTRAINT "likes_revision_check" CHECK ("likes"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mute_words" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"value" text NOT NULL,
	"targets" text[] DEFAULT array[]::text[] NOT NULL,
	"actor_target" text DEFAULT 'all' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mute_words_user_id_value_key" UNIQUE("user_id","value"),
	CONSTRAINT "mute_words_actor_target_check" CHECK ("mute_words"."actor_target" in ('all', 'exclude-following')),
	CONSTRAINT "mute_words_targets_check" CHECK ("mute_words"."targets" <@ array['content', 'tag']::text[]),
	CONSTRAINT "mute_words_value_length_check" CHECK (length("mute_words"."value") <= 100)
);
--> statement-breakpoint
CREATE TABLE "mutes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"muted_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mutes_user_id_muted_id_key" UNIQUE("user_id","muted_id")
);
--> statement-breakpoint
CREATE TABLE "pokes" (
	"id" text PRIMARY KEY NOT NULL,
	"poker_id" text NOT NULL,
	"poked_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pokes_poker_id_poked_id_key" UNIQUE("poker_id","poked_id")
);
--> statement-breakpoint
CREATE TABLE "post_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"subscriber_id" text NOT NULL,
	"author_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_subscriptions_subscriber_id_author_id_key" UNIQUE("subscriber_id","author_id")
);
--> statement-breakpoint
CREATE TABLE "actor_key_pairs" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"public_key_pem" text NOT NULL,
	"private_key_pem" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_key_pairs_oxy_user_id_key" UNIQUE("oxy_user_id")
);
--> statement-breakpoint
CREATE TABLE "federated_actor_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "federated_actor_fields_actor_id_position_key" UNIQUE("actor_id","position"),
	CONSTRAINT "federated_actor_fields_position_check" CHECK ("federated_actor_fields"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "federated_actors" (
	"id" text PRIMARY KEY NOT NULL,
	"protocol" text DEFAULT 'activitypub' NOT NULL,
	"uri" text NOT NULL,
	"username" text NOT NULL,
	"domain" text NOT NULL,
	"acct" text NOT NULL,
	"summary" text,
	"avatar_url" text,
	"header_url" text,
	"inbox_url" text,
	"outbox_url" text,
	"shared_inbox_url" text,
	"followers_url" text,
	"following_url" text,
	"public_key_pem" text,
	"public_key_id" text,
	"type" text DEFAULT 'Person' NOT NULL,
	"manually_approves_followers" boolean DEFAULT false NOT NULL,
	"discoverable" boolean DEFAULT true NOT NULL,
	"memorial" boolean DEFAULT false NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"featured_url" text,
	"featured_tags_url" text,
	"also_known_as" text[],
	"remote_created_at" timestamp with time zone,
	"followers_count" integer DEFAULT 0 NOT NULL,
	"following_count" integer DEFAULT 0 NOT NULL,
	"posts_count" integer DEFAULT 0 NOT NULL,
	"oxy_user_id" text,
	"last_fetched_at" timestamp with time zone,
	"last_outbox_sync_at" timestamp with time zone,
	"outbox_backfill_status" text,
	"outbox_backfill_outbox_url" text,
	"outbox_backfill_cursor_url" text,
	"outbox_backfill_cursor_item_offset" integer DEFAULT 0 NOT NULL,
	"outbox_backfill_processed_count" integer DEFAULT 0 NOT NULL,
	"outbox_backfill_imported_count" integer DEFAULT 0 NOT NULL,
	"outbox_backfill_existing_count" integer DEFAULT 0 NOT NULL,
	"outbox_backfill_page_count" integer DEFAULT 0 NOT NULL,
	"outbox_backfill_locked_until" timestamp with time zone,
	"outbox_backfill_last_run_at" timestamp with time zone,
	"outbox_backfill_completed_at" timestamp with time zone,
	"outbox_backfill_last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federated_actors_uri_key" UNIQUE("uri"),
	CONSTRAINT "federated_actors_acct_key" UNIQUE("acct"),
	CONSTRAINT "federated_actors_domain_username_key" UNIQUE("domain","username"),
	CONSTRAINT "federated_actors_protocol_check" CHECK ("federated_actors"."protocol" in ('activitypub', 'atproto')),
	CONSTRAINT "federated_actors_type_check" CHECK ("federated_actors"."type" in ('Person', 'Service', 'Application', 'Group', 'Organization')),
	CONSTRAINT "federated_actors_outbox_backfill_status_check" CHECK ("federated_actors"."outbox_backfill_status" is null or "federated_actors"."outbox_backfill_status" in ('pending', 'complete', 'unavailable', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "federated_follows" (
	"id" text PRIMARY KEY NOT NULL,
	"local_user_id" text NOT NULL,
	"remote_actor_uri" text NOT NULL,
	"direction" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"network" text DEFAULT 'activitypub' NOT NULL,
	"activity_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federated_follows_local_remote_direction_key" UNIQUE("local_user_id","remote_actor_uri","direction"),
	CONSTRAINT "federated_follows_direction_check" CHECK ("federated_follows"."direction" in ('outbound', 'inbound')),
	CONSTRAINT "federated_follows_status_check" CHECK ("federated_follows"."status" in ('pending', 'accepted', 'rejected')),
	CONSTRAINT "federated_follows_network_check" CHECK ("federated_follows"."network" in ('activitypub', 'atproto'))
);
--> statement-breakpoint
CREATE TABLE "federated_media_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"remote_url" text NOT NULL,
	"oxy_file_id" text,
	"poster_file_id" text,
	"content_type" text,
	"size_bytes" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cached_at" timestamp with time zone,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federated_media_cache_remote_url_key" UNIQUE("remote_url"),
	CONSTRAINT "federated_media_cache_state_check" CHECK ("federated_media_cache"."state" in ('pending', 'cached', 'evicted', 'failed')),
	CONSTRAINT "federated_media_cache_fail_count_check" CHECK ("federated_media_cache"."fail_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "federation_delivery_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"activity_json" jsonb NOT NULL,
	"target_inbox" text NOT NULL,
	"sender_oxy_user_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"migrated_to_bullmq" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_delivery_queue_status_check" CHECK ("federation_delivery_queue"."status" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "federation_delivery_queue_attempts_check" CHECK ("federation_delivery_queue"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "custom_feed_definition_modules" (
	"id" text PRIMARY KEY NOT NULL,
	"feed_id" text NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"module" text NOT NULL,
	"enabled" boolean NOT NULL,
	"params" jsonb,
	"weight" double precision,
	CONSTRAINT "custom_feed_definition_modules_feed_kind_position_key" UNIQUE("feed_id","kind","position"),
	CONSTRAINT "custom_feed_definition_modules_kind_check" CHECK ("custom_feed_definition_modules"."kind" in ('source', 'signal', 'filter')),
	CONSTRAINT "custom_feed_definition_modules_position_check" CHECK ("custom_feed_definition_modules"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "custom_feed_members" (
	"id" text PRIMARY KEY NOT NULL,
	"feed_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "custom_feed_members_feed_id_oxy_user_id_key" UNIQUE("feed_id","oxy_user_id"),
	CONSTRAINT "custom_feed_members_feed_id_position_key" UNIQUE("feed_id","position"),
	CONSTRAINT "custom_feed_members_position_check" CHECK ("custom_feed_members"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "custom_feed_source_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"feed_id" text NOT NULL,
	"list_id" text NOT NULL,
	CONSTRAINT "custom_feed_source_lists_feed_id_list_id_key" UNIQUE("feed_id","list_id")
);
--> statement-breakpoint
CREATE TABLE "custom_feed_topics" (
	"id" text PRIMARY KEY NOT NULL,
	"feed_id" text NOT NULL,
	"topic_id" text NOT NULL,
	CONSTRAINT "custom_feed_topics_feed_id_topic_id_key" UNIQUE("feed_id","topic_id")
);
--> statement-breakpoint
CREATE TABLE "custom_feeds" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_oxy_user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"icon" text,
	"definition_mode" text,
	"keywords" text[],
	"include_replies" boolean DEFAULT true NOT NULL,
	"include_boosts" boolean DEFAULT true NOT NULL,
	"include_media" boolean DEFAULT true NOT NULL,
	"language" text,
	"category" text,
	"tags" text[],
	"cover_image" text,
	"subscriber_count" integer DEFAULT 0 NOT NULL,
	"average_rating" double precision DEFAULT 0 NOT NULL,
	"ratings_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_feeds_definition_mode_check" CHECK ("custom_feeds"."definition_mode" is null or "custom_feeds"."definition_mode" in ('ranked', 'chronological')),
	CONSTRAINT "custom_feeds_category_check" CHECK ("custom_feeds"."category" is null or "custom_feeds"."category" in ('news', 'tech', 'culture', 'finance', 'health', 'sports', 'entertainment', 'other')),
	CONSTRAINT "custom_feeds_counts_check" CHECK ("custom_feeds"."subscriber_count" >= 0 and "custom_feeds"."ratings_count" >= 0),
	CONSTRAINT "custom_feeds_average_rating_check" CHECK ("custom_feeds"."average_rating" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "feed_generators" (
	"id" text PRIMARY KEY NOT NULL,
	"uri" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"avatar" text,
	"algorithm" text NOT NULL,
	"created_by" text NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"subscriber_count" integer DEFAULT 0 NOT NULL,
	"source_network" text,
	"source_service_did" text,
	"source_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_generators_uri_key" UNIQUE("uri"),
	CONSTRAINT "feed_generators_source_network_check" CHECK ("feed_generators"."source_network" is null or "feed_generators"."source_network" in ('atproto')),
	CONSTRAINT "feed_generators_source_complete_check" CHECK (("feed_generators"."source_network" is null and "feed_generators"."source_service_did" is null and "feed_generators"."source_synced_at" is null)
        or ("feed_generators"."source_network" is not null and "feed_generators"."source_service_did" is not null and "feed_generators"."source_synced_at" is not null)),
	CONSTRAINT "feed_generators_counts_check" CHECK ("feed_generators"."like_count" >= 0 and "feed_generators"."subscriber_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "feed_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"feed_descriptor" text NOT NULL,
	"post_uri" text NOT NULL,
	"event" text NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_interactions_event_check" CHECK ("feed_interactions"."event" in ('impression', 'click', 'like', 'reply', 'boost', 'save', 'report'))
);
--> statement-breakpoint
CREATE TABLE "feed_likes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"feed_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_likes_user_id_feed_id_key" UNIQUE("user_id","feed_id")
);
--> statement-breakpoint
CREATE TABLE "feed_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"feed_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"rating" integer NOT NULL,
	"review_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_reviews_feed_id_reviewer_id_key" UNIQUE("feed_id","reviewer_id"),
	CONSTRAINT "feed_reviews_rating_check" CHECK ("feed_reviews"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "user_feed_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_feed_preferences_oxy_user_id_key" UNIQUE("oxy_user_id")
);
--> statement-breakpoint
CREATE TABLE "user_saved_feeds" (
	"id" text PRIMARY KEY NOT NULL,
	"preference_id" text NOT NULL,
	"key" text NOT NULL,
	"descriptor" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_saved_feeds_preference_id_key_key" UNIQUE("preference_id","key")
);
--> statement-breakpoint
CREATE TABLE "postgates" (
	"id" text PRIMARY KEY NOT NULL,
	"post_uri" text NOT NULL,
	"post_id" text NOT NULL,
	"disable_quotes" boolean DEFAULT false NOT NULL,
	"detached_quote_uris" text[],
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "postgates_post_uri_key" UNIQUE("post_uri")
);
--> statement-breakpoint
CREATE TABLE "threadgate_allow_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"threadgate_id" text NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"list_id" text,
	CONSTRAINT "threadgate_allow_rules_threadgate_id_position_key" UNIQUE("threadgate_id","position"),
	CONSTRAINT "threadgate_allow_rules_type_check" CHECK ("threadgate_allow_rules"."type" in ('mentionedOnly', 'followingOnly', 'followerOnly', 'listOnly')),
	CONSTRAINT "threadgate_allow_rules_list_id_check" CHECK (("threadgate_allow_rules"."type" = 'listOnly') = ("threadgate_allow_rules"."list_id" is not null)),
	CONSTRAINT "threadgate_allow_rules_position_check" CHECK ("threadgate_allow_rules"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "threadgates" (
	"id" text PRIMARY KEY NOT NULL,
	"post_uri" text NOT NULL,
	"post_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threadgates_post_uri_key" UNIQUE("post_uri")
);
--> statement-breakpoint
CREATE TABLE "account_list_members" (
	"id" text PRIMARY KEY NOT NULL,
	"list_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "account_list_members_list_id_oxy_user_id_key" UNIQUE("list_id","oxy_user_id"),
	CONSTRAINT "account_list_members_list_id_position_key" UNIQUE("list_id","position"),
	CONSTRAINT "account_list_members_position_check" CHECK ("account_list_members"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "account_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_oxy_user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"is_public" boolean DEFAULT true NOT NULL,
	"subscriber_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_lists_subscriber_count_check" CHECK ("account_lists"."subscriber_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "starter_pack_members" (
	"id" text PRIMARY KEY NOT NULL,
	"pack_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "starter_pack_members_pack_id_oxy_user_id_key" UNIQUE("pack_id","oxy_user_id"),
	CONSTRAINT "starter_pack_members_pack_id_position_key" UNIQUE("pack_id","position"),
	CONSTRAINT "starter_pack_members_position_check" CHECK ("starter_pack_members"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "starter_pack_uses" (
	"id" text PRIMARY KEY NOT NULL,
	"pack_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "starter_pack_uses_pack_id_oxy_user_id_key" UNIQUE("pack_id","oxy_user_id")
);
--> statement-breakpoint
CREATE TABLE "starter_packs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_oxy_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"use_count" integer DEFAULT 0 NOT NULL,
	"source_network" text,
	"source_uri" text,
	"source_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "starter_packs_use_count_check" CHECK ("starter_packs"."use_count" >= 0),
	CONSTRAINT "starter_packs_source_network_check" CHECK ("starter_packs"."source_network" is null or "starter_packs"."source_network" in ('atproto')),
	CONSTRAINT "starter_packs_source_complete_check" CHECK (("starter_packs"."source_network" is null and "starter_packs"."source_uri" is null and "starter_packs"."source_synced_at" is null)
        or ("starter_packs"."source_network" is not null and "starter_packs"."source_uri" is not null and "starter_packs"."source_synced_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "content_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"labeler_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"label_slug" text NOT NULL,
	"created_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_labels_labeler_target_slug_key" UNIQUE("labeler_id","target_type","target_id","label_slug"),
	CONSTRAINT "content_labels_target_type_check" CHECK ("content_labels"."target_type" in ('post', 'user'))
);
--> statement-breakpoint
CREATE TABLE "labeler_label_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"labeler_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"severity" text NOT NULL,
	"default_action" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "labeler_label_definitions_labeler_id_slug_key" UNIQUE("labeler_id","slug"),
	CONSTRAINT "labeler_label_definitions_labeler_id_position_key" UNIQUE("labeler_id","position"),
	CONSTRAINT "labeler_label_definitions_severity_check" CHECK ("labeler_label_definitions"."severity" in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "labeler_label_definitions_default_action_check" CHECK ("labeler_label_definitions"."default_action" in ('show', 'warn', 'blur', 'hide')),
	CONSTRAINT "labeler_label_definitions_position_check" CHECK ("labeler_label_definitions"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "labelers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"creator_id" text NOT NULL,
	"is_official" boolean DEFAULT false NOT NULL,
	"subscriber_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labelers_subscriber_count_check" CHECK ("labelers"."subscriber_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "moderation_enforcements" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"decision_revision" integer NOT NULL,
	"action" text NOT NULL,
	"case_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"outcome" text NOT NULL,
	"recommended_action" text,
	"reason" text NOT NULL,
	"mode" text NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"applied_at" timestamp with time zone,
	"skipped_reason" text,
	"previous_state_post_status" text,
	"previous_state_metadata_is_sensitive" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_enforcements_idempotency_key" UNIQUE("decision_id","decision_revision","action"),
	CONSTRAINT "moderation_enforcements_action_check" CHECK ("moderation_enforcements"."action" in ('none', 'restrict', 'restore', 'label_sensitive', 'unlabel_sensitive', 'manual_review')),
	CONSTRAINT "moderation_enforcements_mode_check" CHECK ("moderation_enforcements"."mode" in ('observe', 'manual', 'automatic')),
	CONSTRAINT "moderation_enforcements_revision_check" CHECK ("moderation_enforcements"."decision_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "moderation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text,
	"case_id" text,
	"payload" jsonb,
	"state" text DEFAULT 'claimed' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_events_state_check" CHECK ("moderation_events"."state" in ('claimed', 'queued', 'ignored'))
);
--> statement-breakpoint
CREATE TABLE "moderation_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload_report_id" text,
	"payload_event_id" text,
	"payload_case_id" text,
	"payload_decision" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_outbox_kind_check" CHECK ("moderation_outbox"."kind" in ('report.submit', 'decision.apply')),
	CONSTRAINT "moderation_outbox_status_check" CHECK ("moderation_outbox"."status" in ('pending', 'processing', 'processed', 'dead_letter')),
	CONSTRAINT "moderation_outbox_attempts_check" CHECK ("moderation_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reported_type" text NOT NULL,
	"reported_id" text NOT NULL,
	"reporter" text NOT NULL,
	"categories" text[] NOT NULL,
	"details" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"local_status" text DEFAULT 'received' NOT NULL,
	"local_status_reason" text,
	"crowd_source_report_id" text,
	"crowd_source_case_id" text,
	"crowd_source_merged" boolean,
	"submitted_at" timestamp with time zone,
	"decision_id" text,
	"decision_revision" integer,
	"decision_outcome" text,
	"decision_status" text,
	"decided_at" timestamp with time zone,
	"enforced_action" text,
	"enforced_at" timestamp with time zone,
	"content_snapshot_hash" text,
	"last_delivery_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_reporter_reported_key" UNIQUE("reporter","reported_id","reported_type"),
	CONSTRAINT "reports_reported_type_check" CHECK ("reports"."reported_type" in ('post', 'user', 'comment', 'message', 'room')),
	CONSTRAINT "reports_status_check" CHECK ("reports"."status" in ('pending', 'reviewed', 'resolved', 'dismissed')),
	CONSTRAINT "reports_local_status_check" CHECK ("reports"."local_status" in ('received', 'queued', 'submitted', 'delivery_failed', 'closed')),
	CONSTRAINT "reports_enforced_action_check" CHECK ("reports"."enforced_action" is null or "reports"."enforced_action" in ('none', 'restrict', 'restore', 'label_sensitive', 'unlabel_sensitive', 'manual_review')),
	CONSTRAINT "reports_categories_check" CHECK (array_length("reports"."categories", 1) >= 1
        and "reports"."categories" <@ array['spam', 'hate_speech', 'harassment', 'misinformation', 'explicit_content', 'other']::text[]),
	CONSTRAINT "reports_decision_revision_check" CHECK ("reports"."decision_revision" is null or "reports"."decision_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "mention_node_ingest_witnesses" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"record_id" text NOT NULL,
	"witness_signature" text NOT NULL,
	"ingested_at" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mention_node_ingest_witnesses_record_id_key" UNIQUE("record_id"),
	CONSTRAINT "mention_node_ingest_witnesses_ingested_at_check" CHECK ("mention_node_ingest_witnesses"."ingested_at" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mention_repo_heads" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"subject_did" text NOT NULL,
	"seq" bigint NOT NULL,
	"head_record_id" text NOT NULL,
	"record_count" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mention_repo_heads_oxy_user_id_key" UNIQUE("oxy_user_id"),
	CONSTRAINT "mention_repo_heads_seq_check" CHECK ("mention_repo_heads"."seq" >= 0),
	CONSTRAINT "mention_repo_heads_record_count_check" CHECK ("mention_repo_heads"."record_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mention_signed_records" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_did" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"type" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"public_key" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"seq" bigint,
	"prev" text,
	"record_id" text,
	"chain_status" text,
	"idempotency_key" text,
	"nsid" text,
	"rkey" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mention_signed_records_chain_status_check" CHECK ("mention_signed_records"."chain_status" is null or "mention_signed_records"."chain_status" in ('canonical', 'conflict')),
	CONSTRAINT "mention_signed_records_seq_check" CHECK ("mention_signed_records"."seq" is null or "mention_signed_records"."seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mention_user_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"node_did" text,
	"endpoint" text NOT NULL,
	"node_public_key" text NOT NULL,
	"mode" text DEFAULT 'pull' NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"controller" text DEFAULT 'self' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_probe_at" timestamp with time zone,
	"last_error" text,
	"cursor" bigint,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mention_user_nodes_oxy_user_id_key" UNIQUE("oxy_user_id"),
	CONSTRAINT "mention_user_nodes_mode_check" CHECK ("mention_user_nodes"."mode" in ('pull', 'push')),
	CONSTRAINT "mention_user_nodes_controller_check" CHECK ("mention_user_nodes"."controller" in ('self', 'oxy')),
	CONSTRAINT "mention_user_nodes_status_check" CHECK ("mention_user_nodes"."status" in ('active', 'unreachable', 'revoked')),
	CONSTRAINT "mention_user_nodes_cursor_check" CHECK ("mention_user_nodes"."cursor" is null or "mention_user_nodes"."cursor" >= 0),
	CONSTRAINT "mention_user_nodes_managed_controller_check" CHECK ("mention_user_nodes"."managed" = ("mention_user_nodes"."controller" = 'oxy'))
);
--> statement-breakpoint
CREATE TABLE "endorsement_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"error" text,
	"pending_remove_owner_id" text,
	"pending_remove_member_ids" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endorsement_outbox_source_source_id_key" UNIQUE("source","source_id"),
	CONSTRAINT "endorsement_outbox_source_check" CHECK ("endorsement_outbox"."source" in ('starterPack', 'accountList')),
	CONSTRAINT "endorsement_outbox_status_check" CHECK ("endorsement_outbox"."status" in ('pending', 'sent')),
	CONSTRAINT "endorsement_outbox_attempts_check" CHECK ("endorsement_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "engagement_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"revision" integer NOT NULL,
	"payload_actor_oxy_user_id" text NOT NULL,
	"payload_post_id" text NOT NULL,
	"payload_relationship_id" text NOT NULL,
	"payload_post_owner_oxy_user_id" text,
	"payload_federation_activity_id" text,
	"payload_previous_value" integer,
	"payload_value" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_outbox_kind_check" CHECK ("engagement_outbox"."kind" in ('post.like', 'post.unlike', 'post.downvote', 'post.undownvote', 'post.save', 'post.unsave')),
	CONSTRAINT "engagement_outbox_status_check" CHECK ("engagement_outbox"."status" in ('pending', 'processing', 'processed')),
	CONSTRAINT "engagement_outbox_revision_check" CHECK ("engagement_outbox"."revision" >= 1),
	CONSTRAINT "engagement_outbox_attempts_check" CHECK ("engagement_outbox"."attempts" >= 0),
	CONSTRAINT "engagement_outbox_values_check" CHECK (("engagement_outbox"."payload_previous_value" is null or "engagement_outbox"."payload_previous_value" in (1, -1))
        and ("engagement_outbox"."payload_value" is null or "engagement_outbox"."payload_value" in (1, -1)))
);
--> statement-breakpoint
CREATE TABLE "post_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"attachment_id" text,
	"media_type" text,
	CONSTRAINT "post_attachments_post_id_position_key" UNIQUE("post_id","position"),
	CONSTRAINT "post_attachments_type_check" CHECK ("post_attachments"."type" in ('media', 'poll', 'article', 'event', 'location', 'sources', 'room', 'podcast')),
	CONSTRAINT "post_attachments_media_type_check" CHECK ("post_attachments"."media_type" is null or "post_attachments"."media_type" in ('image', 'video', 'gif')),
	CONSTRAINT "post_attachments_media_fields_check" CHECK ("post_attachments"."type" <> 'media' or ("post_attachments"."attachment_id" is not null and "post_attachments"."media_type" is not null)),
	CONSTRAINT "post_attachments_position_check" CHECK ("post_attachments"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "post_authorships" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"invited_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	CONSTRAINT "post_authorships_post_id_oxy_user_id_key" UNIQUE("post_id","oxy_user_id"),
	CONSTRAINT "post_authorships_role_check" CHECK ("post_authorships"."role" in ('owner', 'collaborator')),
	CONSTRAINT "post_authorships_status_check" CHECK ("post_authorships"."status" in ('accepted', 'pending', 'declined', 'stopped'))
);
--> statement-breakpoint
CREATE TABLE "post_classification_topic_refs" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"name" text NOT NULL,
	"topic_id" text,
	"relevance" integer,
	"type" text,
	CONSTRAINT "post_classification_topic_refs_post_id_name_key" UNIQUE("post_id","name"),
	CONSTRAINT "post_classification_topic_refs_type_check" CHECK ("post_classification_topic_refs"."type" is null or "post_classification_topic_refs"."type" in ('topic', 'entity')),
	CONSTRAINT "post_classification_topic_refs_relevance_check" CHECK ("post_classification_topic_refs"."relevance" is null or "post_classification_topic_refs"."relevance" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "post_content_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"position" integer NOT NULL,
	"tag" text,
	"source" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"article_title" text,
	"article_body" text,
	"article_excerpt" text,
	"variant_created_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED,
	CONSTRAINT "post_content_variants_post_id_position_key" UNIQUE("post_id","position"),
	CONSTRAINT "post_content_variants_source_check" CHECK ("post_content_variants"."source" in ('author', 'machine')),
	CONSTRAINT "post_content_variants_position_check" CHECK ("post_content_variants"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "post_media" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"position" integer NOT NULL,
	"media_id" text NOT NULL,
	"type" text NOT NULL,
	"alt" text,
	"width" integer,
	"height" integer,
	"duration_sec" double precision,
	"size_bytes" integer,
	"orientation" text,
	"aspect_ratio" double precision,
	"mime" text,
	"remote_url" text,
	"cached_from_federation" boolean,
	CONSTRAINT "post_media_post_id_position_key" UNIQUE("post_id","position"),
	CONSTRAINT "post_media_type_check" CHECK ("post_media"."type" in ('image', 'video', 'gif')),
	CONSTRAINT "post_media_orientation_check" CHECK ("post_media"."orientation" is null or "post_media"."orientation" in ('portrait', 'landscape', 'square')),
	CONSTRAINT "post_media_positive_dimensions_check" CHECK (("post_media"."width" is null or "post_media"."width" > 0)
        and ("post_media"."height" is null or "post_media"."height" > 0)
        and ("post_media"."duration_sec" is null or "post_media"."duration_sec" > 0)
        and ("post_media"."size_bytes" is null or "post_media"."size_bytes" > 0)
        and ("post_media"."aspect_ratio" is null or "post_media"."aspect_ratio" > 0)),
	CONSTRAINT "post_media_position_check" CHECK ("post_media"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "post_mentions" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	CONSTRAINT "post_mentions_post_id_oxy_user_id_key" UNIQUE("post_id","oxy_user_id")
);
--> statement-breakpoint
CREATE TABLE "post_recent_repliers" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"replied_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_recent_repliers_post_id_oxy_user_id_key" UNIQUE("post_id","oxy_user_id")
);
--> statement-breakpoint
CREATE TABLE "post_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	"title" text,
	CONSTRAINT "post_sources_post_id_position_key" UNIQUE("post_id","position"),
	CONSTRAINT "post_sources_position_check" CHECK ("post_sources"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "post_variant_alt_texts" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"media_id" text NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "post_variant_alt_texts_variant_id_media_id_key" UNIQUE("variant_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "post_variant_media" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"position" integer NOT NULL,
	"media_id" text NOT NULL,
	"type" text NOT NULL,
	"alt" text,
	"width" integer,
	"height" integer,
	"duration_sec" double precision,
	"size_bytes" integer,
	"orientation" text,
	"aspect_ratio" double precision,
	"mime" text,
	"remote_url" text,
	"cached_from_federation" boolean,
	CONSTRAINT "post_variant_media_variant_id_position_key" UNIQUE("variant_id","position"),
	CONSTRAINT "post_variant_media_type_check" CHECK ("post_variant_media"."type" in ('image', 'video', 'gif')),
	CONSTRAINT "post_variant_media_orientation_check" CHECK ("post_variant_media"."orientation" is null or "post_variant_media"."orientation" in ('portrait', 'landscape', 'square')),
	CONSTRAINT "post_variant_media_positive_dimensions_check" CHECK (("post_variant_media"."width" is null or "post_variant_media"."width" > 0)
        and ("post_variant_media"."height" is null or "post_variant_media"."height" > 0)
        and ("post_variant_media"."duration_sec" is null or "post_variant_media"."duration_sec" > 0)
        and ("post_variant_media"."size_bytes" is null or "post_variant_media"."size_bytes" > 0)
        and ("post_variant_media"."aspect_ratio" is null or "post_variant_media"."aspect_ratio" > 0)),
	CONSTRAINT "post_variant_media_position_check" CHECK ("post_variant_media"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text,
	"type" text DEFAULT 'text' NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"has_links" boolean DEFAULT false NOT NULL,
	"is_edited" boolean DEFAULT false NOT NULL,
	"language" text,
	"curated" boolean,
	"tags" text[],
	"hashtags" text[],
	"edit_history" text[],
	"reply_permission" text[] DEFAULT array['anyone']::text[] NOT NULL,
	"review_replies" boolean DEFAULT false NOT NULL,
	"quotes_disabled" boolean DEFAULT false NOT NULL,
	"boost_of" text,
	"quote_of" text,
	"parent_post_id" text,
	"thread_id" text,
	"scheduled_for" timestamp with time zone,
	"stats_likes_count" integer DEFAULT 0 NOT NULL,
	"stats_downvotes_count" integer DEFAULT 0 NOT NULL,
	"stats_boosts_count" integer DEFAULT 0 NOT NULL,
	"stats_federated_boosts_count" integer DEFAULT 0 NOT NULL,
	"stats_comments_count" integer DEFAULT 0 NOT NULL,
	"stats_views_count" integer DEFAULT 0 NOT NULL,
	"stats_shares_count" integer DEFAULT 0 NOT NULL,
	"stats_saves_count" integer DEFAULT 0 NOT NULL,
	"metadata_is_sensitive" boolean DEFAULT false NOT NULL,
	"metadata_is_pinned" boolean DEFAULT false NOT NULL,
	"metadata_is_boosted" boolean DEFAULT false NOT NULL,
	"metadata_is_commented" boolean DEFAULT false NOT NULL,
	"metadata_is_following_author" boolean DEFAULT false NOT NULL,
	"metadata_author_blocked" boolean DEFAULT false NOT NULL,
	"metadata_author_muted" boolean DEFAULT false NOT NULL,
	"metadata_hide_engagement_counts" boolean DEFAULT false NOT NULL,
	"federation_activity_id" text,
	"federation_actor_uri" text,
	"federation_in_reply_to" text,
	"federation_url" text,
	"federation_sensitive" boolean,
	"federation_spoiler_text" text,
	"content_poll_id" text,
	"content_article_id" text,
	"content_article_title" text,
	"content_article_excerpt" text,
	"content_event_id" text,
	"content_event_name" text,
	"content_event_date" timestamp with time zone,
	"content_event_location" text,
	"content_event_description" text,
	"content_room_id" text,
	"content_room_title" text,
	"content_room_status" text,
	"content_room_topic" text,
	"content_room_host" text,
	"content_podcast_syra_id" text,
	"content_podcast_title" text,
	"content_podcast_author" text,
	"content_podcast_artwork_url" text,
	"content_podcast_show_url" text,
	"content_location_latitude" double precision,
	"content_location_longitude" double precision,
	"content_location_address" text,
	"content_geo" "geography" GENERATED ALWAYS AS (ST_MakePoint(content_location_longitude, content_location_latitude)::geography) STORED,
	"location_latitude" double precision,
	"location_longitude" double precision,
	"location_address" text,
	"geo" "geography" GENERATED ALWAYS AS (ST_MakePoint(location_longitude, location_latitude)::geography) STORED,
	"classification_topics" text[],
	"classification_languages" text[],
	"classification_region" text,
	"classification_hashtags_norm" text[],
	"classification_sensitive" boolean,
	"classification_version" integer,
	"classification_sentiment" text DEFAULT 'neutral' NOT NULL,
	"classification_intent" text DEFAULT 'other' NOT NULL,
	"classification_score_toxicity" double precision DEFAULT 0 NOT NULL,
	"classification_score_constructiveness" double precision DEFAULT 0 NOT NULL,
	"classification_score_spam" double precision DEFAULT 0 NOT NULL,
	"classification_score_quality" double precision DEFAULT 0 NOT NULL,
	"classification_score_controversy" double precision DEFAULT 0 NOT NULL,
	"classification_score_negativity" double precision DEFAULT 0 NOT NULL,
	"classification_confidence" double precision DEFAULT 0 NOT NULL,
	"classification_status" text DEFAULT 'pending' NOT NULL,
	"classification_attempts" integer DEFAULT 0 NOT NULL,
	"classification_classified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_type_check" CHECK ("posts"."type" in ('text', 'image', 'video', 'poll', 'boost', 'quote')),
	CONSTRAINT "posts_visibility_check" CHECK ("posts"."visibility" in ('public', 'followers_only', 'private')),
	CONSTRAINT "posts_status_check" CHECK ("posts"."status" in ('draft', 'published', 'scheduled', 'restricted')),
	CONSTRAINT "posts_room_status_check" CHECK ("posts"."content_room_status" is null or "posts"."content_room_status" in ('scheduled', 'live', 'ended')),
	CONSTRAINT "posts_classification_status_check" CHECK ("posts"."classification_status" in ('pending', 'baseline', 'classified', 'failed')),
	CONSTRAINT "posts_classification_sentiment_check" CHECK ("posts"."classification_sentiment" in ('positive', 'neutral', 'negative', 'mixed')),
	CONSTRAINT "posts_classification_intent_check" CHECK ("posts"."classification_intent" in ('question', 'announcement', 'feedback', 'opinion', 'complaint', 'joke', 'news', 'personal_update', 'other')),
	CONSTRAINT "posts_reply_permission_check" CHECK ("posts"."reply_permission" <@ array['anyone', 'followers', 'following', 'mentioned', 'nobody']::text[]),
	CONSTRAINT "posts_classification_scores_check" CHECK ("posts"."classification_score_toxicity" between 0 and 1
        and "posts"."classification_score_constructiveness" between 0 and 1
        and "posts"."classification_score_spam" between 0 and 1
        and "posts"."classification_score_quality" between 0 and 1
        and "posts"."classification_score_controversy" between 0 and 1
        and "posts"."classification_score_negativity" between 0 and 1
        and "posts"."classification_confidence" between 0 and 1),
	CONSTRAINT "posts_content_location_pair_check" CHECK (("posts"."content_location_latitude" is null) = ("posts"."content_location_longitude" is null)),
	CONSTRAINT "posts_location_pair_check" CHECK (("posts"."location_latitude" is null) = ("posts"."location_longitude" is null)),
	CONSTRAINT "posts_content_location_range_check" CHECK ("posts"."content_location_latitude" is null or (
        "posts"."content_location_latitude" between -90 and 90
        and "posts"."content_location_longitude" between -180 and 180)),
	CONSTRAINT "posts_location_range_check" CHECK ("posts"."location_latitude" is null or (
        "posts"."location_latitude" between -90 and 90
        and "posts"."location_longitude" between -180 and 180))
);
--> statement-breakpoint
CREATE TABLE "poll_options" (
	"id" text PRIMARY KEY NOT NULL,
	"poll_id" text NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "poll_options_poll_id_position_key" UNIQUE("poll_id","position"),
	CONSTRAINT "poll_options_position_check" CHECK ("poll_options"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "poll_votes" (
	"id" text PRIMARY KEY NOT NULL,
	"option_id" text NOT NULL,
	"poll_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_votes_option_id_user_id_key" UNIQUE("option_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" text PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"post_id" text,
	"created_by" text NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"is_multiple_choice" boolean DEFAULT false NOT NULL,
	"is_anonymous" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_behavior_authors" (
	"id" text PRIMARY KEY NOT NULL,
	"behavior_id" text NOT NULL,
	"author_id" text NOT NULL,
	"interaction_count" integer DEFAULT 0 NOT NULL,
	"last_interaction_at" timestamp with time zone DEFAULT now() NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"boosts" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"saves" integer DEFAULT 0 NOT NULL,
	"shares" integer DEFAULT 0 NOT NULL,
	"weight" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "user_behavior_authors_behavior_id_author_id_key" UNIQUE("behavior_id","author_id"),
	CONSTRAINT "user_behavior_authors_weight_check" CHECK ("user_behavior_authors"."weight" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "user_behavior_regions" (
	"id" text PRIMARY KEY NOT NULL,
	"behavior_id" text NOT NULL,
	"region" text NOT NULL,
	"count" double precision DEFAULT 0 NOT NULL,
	"last_interaction_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_behavior_regions_behavior_id_region_key" UNIQUE("behavior_id","region"),
	CONSTRAINT "user_behavior_regions_count_check" CHECK ("user_behavior_regions"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_behavior_topics" (
	"id" text PRIMARY KEY NOT NULL,
	"behavior_id" text NOT NULL,
	"topic" text NOT NULL,
	"topic_id" text,
	"interaction_count" integer DEFAULT 0 NOT NULL,
	"last_interaction_at" timestamp with time zone DEFAULT now() NOT NULL,
	"weight" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "user_behavior_topics_behavior_id_topic_key" UNIQUE("behavior_id","topic"),
	CONSTRAINT "user_behavior_topics_weight_check" CHECK ("user_behavior_topics"."weight" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "user_behaviors" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"preferred_post_type_text" integer DEFAULT 0 NOT NULL,
	"preferred_post_type_image" integer DEFAULT 0 NOT NULL,
	"preferred_post_type_video" integer DEFAULT 0 NOT NULL,
	"preferred_post_type_poll" integer DEFAULT 0 NOT NULL,
	"active_hours" integer[],
	"preferred_languages" text[],
	"average_engagement_time" double precision DEFAULT 0 NOT NULL,
	"skip_rate" double precision DEFAULT 0 NOT NULL,
	"completion_rate" double precision DEFAULT 0 NOT NULL,
	"hidden_authors" text[],
	"muted_authors" text[],
	"blocked_authors" text[],
	"hidden_topics" text[],
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_behaviors_oxy_user_id_key" UNIQUE("oxy_user_id"),
	CONSTRAINT "user_behaviors_rates_check" CHECK ("user_behaviors"."skip_rate" between 0 and 1 and "user_behaviors"."completion_rate" between 0 and 1),
	CONSTRAINT "user_behaviors_active_hours_check" CHECK ("user_behaviors"."active_hours" <@ array[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]::integer[])
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"appearance_theme_mode" text DEFAULT 'system' NOT NULL,
	"appearance_primary_color" text,
	"appearance_post_text_expand" text DEFAULT 'default' NOT NULL,
	"appearance_post_read_more_action" text DEFAULT 'openPost' NOT NULL,
	"appearance_collapse_long_bio" boolean DEFAULT true NOT NULL,
	"profile_header_image" text,
	"privacy_profile_visibility" text DEFAULT 'public' NOT NULL,
	"privacy_show_contact_info" boolean DEFAULT true NOT NULL,
	"privacy_allow_tags" boolean DEFAULT true NOT NULL,
	"privacy_allow_mentions" boolean DEFAULT true NOT NULL,
	"privacy_show_online_status" boolean DEFAULT true NOT NULL,
	"privacy_hide_like_counts" boolean DEFAULT false NOT NULL,
	"privacy_hide_share_counts" boolean DEFAULT false NOT NULL,
	"privacy_hide_reply_counts" boolean DEFAULT false NOT NULL,
	"privacy_hide_save_counts" boolean DEFAULT false NOT NULL,
	"privacy_show_sensitive_content" boolean DEFAULT false NOT NULL,
	"privacy_hidden_words" text[],
	"privacy_restricted_users" text[],
	"privacy_subscribed_labelers" text[],
	"profile_cover_photo_enabled" boolean DEFAULT true NOT NULL,
	"profile_minimalist_mode" boolean DEFAULT false NOT NULL,
	"profile_media_type" text,
	"profile_media_title" text,
	"profile_media_artwork_url" text,
	"profile_media_syra_track_id" text,
	"profile_media_artist" text,
	"profile_media_preview_url" text,
	"profile_media_start_sec" double precision,
	"profile_media_duration_sec" double precision,
	"profile_media_syra_podcast_id" text,
	"profile_media_author" text,
	"profile_media_show_url" text,
	"interest_tags" text[],
	"feed_diversity_enabled" boolean DEFAULT true NOT NULL,
	"feed_same_author_penalty" double precision DEFAULT 0.95 NOT NULL,
	"feed_same_topic_penalty" double precision DEFAULT 0.92 NOT NULL,
	"feed_max_consecutive_same_author" integer,
	"feed_recency_half_life_hours" double precision DEFAULT 24 NOT NULL,
	"feed_recency_max_age_hours" double precision DEFAULT 168 NOT NULL,
	"feed_min_engagement_rate" double precision,
	"feed_boost_high_quality" boolean DEFAULT true NOT NULL,
	"tuning_min_length_enabled" boolean,
	"tuning_min_length" integer,
	"tuning_low_effort_gate_enabled" boolean,
	"tuning_min_meaningful_text_length" integer,
	"tuning_native_engagement_enabled" boolean,
	"tuning_min_native_engagement" double precision,
	"tuning_min_quality_enabled" boolean,
	"tuning_min_quality" double precision,
	"notify_push_enabled" boolean DEFAULT true NOT NULL,
	"notify_email_enabled" boolean DEFAULT false NOT NULL,
	"notify_likes" boolean DEFAULT true NOT NULL,
	"notify_boosts" boolean DEFAULT true NOT NULL,
	"notify_follows" boolean DEFAULT true NOT NULL,
	"notify_mentions" boolean DEFAULT true NOT NULL,
	"notify_replies" boolean DEFAULT true NOT NULL,
	"notify_quotes" boolean DEFAULT true NOT NULL,
	"embed_youtube" text,
	"embed_youtube_shorts" text,
	"embed_vimeo" text,
	"embed_twitch" text,
	"embed_giphy" text,
	"embed_spotify" text,
	"embed_apple_music" text,
	"embed_soundcloud" text,
	"embed_flickr" text,
	"embed_bandcamp" text,
	"fediverse_preferred_language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_oxy_user_id_key" UNIQUE("oxy_user_id"),
	CONSTRAINT "user_settings_theme_mode_check" CHECK ("user_settings"."appearance_theme_mode" in ('light', 'dark', 'system', 'adaptive')),
	CONSTRAINT "user_settings_post_text_expand_check" CHECK ("user_settings"."appearance_post_text_expand" in ('default', 'more', 'muchMore', 'all')),
	CONSTRAINT "user_settings_post_read_more_action_check" CHECK ("user_settings"."appearance_post_read_more_action" in ('openPost', 'expandInline')),
	CONSTRAINT "user_settings_profile_visibility_check" CHECK ("user_settings"."privacy_profile_visibility" in ('public', 'private', 'followers_only')),
	CONSTRAINT "user_settings_profile_media_type_check" CHECK ("user_settings"."profile_media_type" is null or "user_settings"."profile_media_type" in ('song', 'podcast')),
	CONSTRAINT "user_settings_profile_media_shape_check" CHECK (("user_settings"."profile_media_type" is null
          and "user_settings"."profile_media_syra_track_id" is null
          and "user_settings"."profile_media_syra_podcast_id" is null)
        or ("user_settings"."profile_media_type" = 'song'
          and "user_settings"."profile_media_syra_track_id" is not null
          and "user_settings"."profile_media_preview_url" is not null
          and "user_settings"."profile_media_syra_podcast_id" is null)
        or ("user_settings"."profile_media_type" = 'podcast'
          and "user_settings"."profile_media_syra_podcast_id" is not null
          and "user_settings"."profile_media_show_url" is not null
          and "user_settings"."profile_media_syra_track_id" is null)),
	CONSTRAINT "user_settings_feed_penalties_check" CHECK ("user_settings"."feed_same_author_penalty" between 0.5 and 1.0
        and "user_settings"."feed_same_topic_penalty" between 0.5 and 1.0),
	CONSTRAINT "user_settings_feed_recency_check" CHECK ("user_settings"."feed_recency_half_life_hours" between 6 and 72
        and "user_settings"."feed_recency_max_age_hours" between 24 and 336),
	CONSTRAINT "user_settings_feed_min_engagement_check" CHECK ("user_settings"."feed_min_engagement_rate" is null or "user_settings"."feed_min_engagement_rate" between 0 and 1),
	CONSTRAINT "user_settings_max_consecutive_same_author_check" CHECK ("user_settings"."feed_max_consecutive_same_author" is null
        or "user_settings"."feed_max_consecutive_same_author" between 1 and 10),
	CONSTRAINT "user_settings_external_embeds_check" CHECK (("user_settings"."embed_youtube" is null or "user_settings"."embed_youtube" in ('show', 'hide'))
        and ("user_settings"."embed_youtube_shorts" is null or "user_settings"."embed_youtube_shorts" in ('show', 'hide'))
        and ("user_settings"."embed_vimeo" is null or "user_settings"."embed_vimeo" in ('show', 'hide'))
        and ("user_settings"."embed_twitch" is null or "user_settings"."embed_twitch" in ('show', 'hide'))
        and ("user_settings"."embed_giphy" is null or "user_settings"."embed_giphy" in ('show', 'hide'))
        and ("user_settings"."embed_spotify" is null or "user_settings"."embed_spotify" in ('show', 'hide'))
        and ("user_settings"."embed_apple_music" is null or "user_settings"."embed_apple_music" in ('show', 'hide'))
        and ("user_settings"."embed_soundcloud" is null or "user_settings"."embed_soundcloud" in ('show', 'hide'))
        and ("user_settings"."embed_flickr" is null or "user_settings"."embed_flickr" in ('show', 'hide'))
        and ("user_settings"."embed_bandcamp" is null or "user_settings"."embed_bandcamp" in ('show', 'hide')))
);
--> statement-breakpoint
CREATE TABLE "user_settings_label_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"settings_id" text NOT NULL,
	"labeler_id" text NOT NULL,
	"label_slug" text NOT NULL,
	"action" text NOT NULL,
	CONSTRAINT "user_settings_label_actions_settings_labeler_slug_key" UNIQUE("settings_id","labeler_id","label_slug"),
	CONSTRAINT "user_settings_label_actions_action_check" CHECK ("user_settings_label_actions"."action" in ('hide', 'warn', 'blur', 'show'))
);
--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federated_actor_fields" ADD CONSTRAINT "federated_actor_fields_actor_id_federated_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."federated_actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_feed_definition_modules" ADD CONSTRAINT "custom_feed_definition_modules_feed_id_custom_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."custom_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_feed_members" ADD CONSTRAINT "custom_feed_members_feed_id_custom_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."custom_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_feed_source_lists" ADD CONSTRAINT "custom_feed_source_lists_feed_id_custom_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."custom_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_feed_source_lists" ADD CONSTRAINT "custom_feed_source_lists_list_id_account_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."account_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_feed_topics" ADD CONSTRAINT "custom_feed_topics_feed_id_custom_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."custom_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_likes" ADD CONSTRAINT "feed_likes_feed_id_custom_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."custom_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_reviews" ADD CONSTRAINT "feed_reviews_feed_id_custom_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."custom_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_saved_feeds" ADD CONSTRAINT "user_saved_feeds_preference_id_user_feed_preferences_id_fk" FOREIGN KEY ("preference_id") REFERENCES "public"."user_feed_preferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threadgate_allow_rules" ADD CONSTRAINT "threadgate_allow_rules_threadgate_id_threadgates_id_fk" FOREIGN KEY ("threadgate_id") REFERENCES "public"."threadgates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_list_members" ADD CONSTRAINT "account_list_members_list_id_account_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."account_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starter_pack_members" ADD CONSTRAINT "starter_pack_members_pack_id_starter_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."starter_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starter_pack_uses" ADD CONSTRAINT "starter_pack_uses_pack_id_starter_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."starter_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_labels" ADD CONSTRAINT "content_labels_labeler_id_labelers_id_fk" FOREIGN KEY ("labeler_id") REFERENCES "public"."labelers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labeler_label_definitions" ADD CONSTRAINT "labeler_label_definitions_labeler_id_labelers_id_fk" FOREIGN KEY ("labeler_id") REFERENCES "public"."labelers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_outbox" ADD CONSTRAINT "moderation_outbox_payload_report_id_reports_id_fk" FOREIGN KEY ("payload_report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_outbox" ADD CONSTRAINT "engagement_outbox_payload_post_id_posts_id_fk" FOREIGN KEY ("payload_post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_attachments" ADD CONSTRAINT "post_attachments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_authorships" ADD CONSTRAINT "post_authorships_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_classification_topic_refs" ADD CONSTRAINT "post_classification_topic_refs_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_content_variants" ADD CONSTRAINT "post_content_variants_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_mentions" ADD CONSTRAINT "post_mentions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_recent_repliers" ADD CONSTRAINT "post_recent_repliers_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_sources" ADD CONSTRAINT "post_sources_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_variant_alt_texts" ADD CONSTRAINT "post_variant_alt_texts_variant_id_post_content_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."post_content_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_variant_media" ADD CONSTRAINT "post_variant_media_variant_id_post_content_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."post_content_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_boost_of_posts_id_fk" FOREIGN KEY ("boost_of") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_quote_of_posts_id_fk" FOREIGN KEY ("quote_of") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_parent_post_id_posts_id_fk" FOREIGN KEY ("parent_post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_thread_id_posts_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_option_id_poll_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."poll_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_behavior_authors" ADD CONSTRAINT "user_behavior_authors_behavior_id_user_behaviors_id_fk" FOREIGN KEY ("behavior_id") REFERENCES "public"."user_behaviors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_behavior_regions" ADD CONSTRAINT "user_behavior_regions_behavior_id_user_behaviors_id_fk" FOREIGN KEY ("behavior_id") REFERENCES "public"."user_behaviors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_behavior_topics" ADD CONSTRAINT "user_behavior_topics_behavior_id_user_behaviors_id_fk" FOREIGN KEY ("behavior_id") REFERENCES "public"."user_behaviors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings_label_actions" ADD CONSTRAINT "user_settings_label_actions_settings_id_user_settings_id_fk" FOREIGN KEY ("settings_id") REFERENCES "public"."user_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "articles_post_id_idx" ON "articles" USING btree ("post_id") WHERE "articles"."post_id" is not null;--> statement-breakpoint
CREATE INDEX "articles_created_by_idx" ON "articles" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "author_follower_snapshots_owner_chrono_idx" ON "author_follower_snapshots" USING btree ("oxy_user_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "author_follower_snapshots_at_idx" ON "author_follower_snapshots" USING btree ("at");--> statement-breakpoint
CREATE INDEX "gifs_search_gin" ON "gifs" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "gifs_use_count_idx" ON "gifs" USING btree ("use_count" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gifs_last_used_at_idx" ON "gifs" USING btree ("last_used_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_recipient_keyset_idx" ON "notifications" USING btree ("recipient_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_recipient_unread_idx" ON "notifications" USING btree ("recipient_id","created_at" DESC NULLS LAST) WHERE "notifications"."read" = false;--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "push_tokens_user_enabled_idx" ON "push_tokens" USING btree ("user_id") WHERE "push_tokens"."enabled";--> statement-breakpoint
CREATE INDEX "topic_stats_popularity_idx" ON "topic_stats" USING btree ("popularity" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trending_batch_idx" ON "trending" USING btree ("calculated_at" DESC NULLS LAST,"score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trending_calculated_at_idx" ON "trending" USING btree ("calculated_at");--> statement-breakpoint
CREATE INDEX "trending_topic_id_idx" ON "trending" USING btree ("topic_id") WHERE "trending"."topic_id" is not null;--> statement-breakpoint
CREATE INDEX "bookmarks_user_id_created_at_idx" ON "bookmarks" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bookmarks_post_id_idx" ON "bookmarks" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "bookmarks_user_id_folder_idx" ON "bookmarks" USING btree ("user_id","folder") WHERE "bookmarks"."folder" is not null;--> statement-breakpoint
CREATE INDEX "entity_follows_entity_idx" ON "entity_follows" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "entity_follows_user_type_idx" ON "entity_follows" USING btree ("user_id","entity_type");--> statement-breakpoint
CREATE INDEX "likes_post_id_idx" ON "likes" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "likes_user_id_created_at_idx" ON "likes" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mutes_muted_id_idx" ON "mutes" USING btree ("muted_id");--> statement-breakpoint
CREATE INDEX "pokes_poked_id_created_at_idx" ON "pokes" USING btree ("poked_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "post_subscriptions_author_id_idx" ON "post_subscriptions" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "federated_actors_protocol_idx" ON "federated_actors" USING btree ("protocol");--> statement-breakpoint
CREATE INDEX "federated_actors_domain_idx" ON "federated_actors" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "federated_actors_public_key_id_idx" ON "federated_actors" USING btree ("public_key_id") WHERE "federated_actors"."public_key_id" is not null;--> statement-breakpoint
CREATE INDEX "federated_actors_last_fetched_at_idx" ON "federated_actors" USING btree ("last_fetched_at");--> statement-breakpoint
CREATE INDEX "federated_actors_backfill_claim_idx" ON "federated_actors" USING btree ("outbox_backfill_status","outbox_backfill_locked_until");--> statement-breakpoint
CREATE INDEX "federated_actors_oxy_user_id_idx" ON "federated_actors" USING btree ("oxy_user_id") WHERE "federated_actors"."oxy_user_id" is not null;--> statement-breakpoint
CREATE INDEX "federated_follows_local_direction_status_idx" ON "federated_follows" USING btree ("local_user_id","direction","status");--> statement-breakpoint
CREATE INDEX "federated_follows_remote_direction_idx" ON "federated_follows" USING btree ("remote_actor_uri","direction");--> statement-breakpoint
CREATE INDEX "federated_media_cache_state_accessed_idx" ON "federated_media_cache" USING btree ("state","last_accessed_at");--> statement-breakpoint
CREATE INDEX "federated_media_cache_state_next_attempt_idx" ON "federated_media_cache" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_delivery_queue_drain_idx" ON "federation_delivery_queue" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "custom_feed_members_oxy_user_id_idx" ON "custom_feed_members" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "custom_feed_source_lists_list_id_idx" ON "custom_feed_source_lists" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "custom_feeds_owner_chrono_idx" ON "custom_feeds" USING btree ("owner_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "custom_feeds_public_chrono_idx" ON "custom_feeds" USING btree ("created_at" DESC NULLS LAST) WHERE "custom_feeds"."is_public";--> statement-breakpoint
CREATE INDEX "custom_feeds_marketplace_idx" ON "custom_feeds" USING btree ("category","subscriber_count" DESC NULLS LAST) WHERE "custom_feeds"."is_public";--> statement-breakpoint
CREATE INDEX "feed_generators_created_by_idx" ON "feed_generators" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "feed_interactions_user_chrono_idx" ON "feed_interactions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feed_interactions_post_event_idx" ON "feed_interactions" USING btree ("post_uri","event");--> statement-breakpoint
CREATE INDEX "feed_interactions_created_at_idx" ON "feed_interactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "feed_likes_feed_id_idx" ON "feed_likes" USING btree ("feed_id");--> statement-breakpoint
CREATE INDEX "feed_likes_user_id_idx" ON "feed_likes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "feed_reviews_reviewer_id_idx" ON "feed_reviews" USING btree ("reviewer_id");--> statement-breakpoint
CREATE INDEX "user_saved_feeds_preference_order_idx" ON "user_saved_feeds" USING btree ("preference_id","order");--> statement-breakpoint
CREATE INDEX "postgates_post_id_idx" ON "postgates" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "postgates_created_by_idx" ON "postgates" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "threadgates_post_id_idx" ON "threadgates" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "threadgates_created_by_idx" ON "threadgates" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "account_list_members_oxy_user_id_idx" ON "account_list_members" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "account_lists_owner_chrono_idx" ON "account_lists" USING btree ("owner_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "account_lists_public_chrono_idx" ON "account_lists" USING btree ("created_at" DESC NULLS LAST) WHERE "account_lists"."is_public";--> statement-breakpoint
CREATE INDEX "starter_pack_members_oxy_user_id_idx" ON "starter_pack_members" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "starter_pack_uses_oxy_user_id_idx" ON "starter_pack_uses" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "starter_packs_source_uri_key" ON "starter_packs" USING btree ("source_uri") WHERE "starter_packs"."source_uri" is not null;--> statement-breakpoint
CREATE INDEX "starter_packs_owner_chrono_idx" ON "starter_packs" USING btree ("owner_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "starter_packs_use_count_idx" ON "starter_packs" USING btree ("use_count" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "content_labels_target_idx" ON "content_labels" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "content_labels_labeler_slug_idx" ON "content_labels" USING btree ("labeler_id","label_slug");--> statement-breakpoint
CREATE INDEX "labelers_creator_id_idx" ON "labelers" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "moderation_enforcements_case_id_idx" ON "moderation_enforcements" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "moderation_enforcements_subject_idx" ON "moderation_enforcements" USING btree ("subject_type","subject_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "moderation_events_case_id_idx" ON "moderation_events" USING btree ("case_id") WHERE "moderation_events"."case_id" is not null;--> statement-breakpoint
CREATE INDEX "moderation_events_state_received_idx" ON "moderation_events" USING btree ("state","received_at");--> statement-breakpoint
CREATE INDEX "moderation_events_expires_at_idx" ON "moderation_events" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "moderation_outbox_due_idx" ON "moderation_outbox" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "moderation_outbox_lease_idx" ON "moderation_outbox" USING btree ("status","lease_until","created_at");--> statement-breakpoint
CREATE INDEX "moderation_outbox_expires_at_idx" ON "moderation_outbox" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "reports_reported_id_idx" ON "reports" USING btree ("reported_id");--> statement-breakpoint
CREATE INDEX "reports_reporter_idx" ON "reports" USING btree ("reporter");--> statement-breakpoint
CREATE INDEX "reports_case_id_idx" ON "reports" USING btree ("crowd_source_case_id") WHERE "reports"."crowd_source_case_id" is not null;--> statement-breakpoint
CREATE INDEX "reports_local_status_chrono_idx" ON "reports" USING btree ("local_status","created_at");--> statement-breakpoint
CREATE INDEX "mention_node_ingest_witnesses_owner_chrono_idx" ON "mention_node_ingest_witnesses" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "mention_signed_records_record_id_key" ON "mention_signed_records" USING btree ("record_id") WHERE "mention_signed_records"."record_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mention_signed_records_oxy_user_id_seq_key" ON "mention_signed_records" USING btree ("oxy_user_id","seq") WHERE "mention_signed_records"."seq" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mention_signed_records_idempotency_key" ON "mention_signed_records" USING btree ("oxy_user_id","idempotency_key") WHERE "mention_signed_records"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "mention_signed_records_materialize_idx" ON "mention_signed_records" USING btree ("oxy_user_id","nsid","rkey","created_at" DESC NULLS LAST) WHERE "mention_signed_records"."nsid" is not null;--> statement-breakpoint
CREATE INDEX "mention_signed_records_subject_did_idx" ON "mention_signed_records" USING btree ("subject_did");--> statement-breakpoint
CREATE INDEX "mention_user_nodes_status_idx" ON "mention_user_nodes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mention_user_nodes_ingest_sweep_idx" ON "mention_user_nodes" USING btree ("status","mode","last_synced_at");--> statement-breakpoint
CREATE INDEX "endorsement_outbox_drain_idx" ON "endorsement_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "engagement_outbox_due_idx" ON "engagement_outbox" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "engagement_outbox_lease_idx" ON "engagement_outbox" USING btree ("status","lease_until","created_at");--> statement-breakpoint
CREATE INDEX "engagement_outbox_relationship_order_idx" ON "engagement_outbox" USING btree ("payload_relationship_id","revision","status");--> statement-breakpoint
CREATE INDEX "engagement_outbox_expires_at_idx" ON "engagement_outbox" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "post_authorships_one_owner_per_post" ON "post_authorships" USING btree ("post_id") WHERE "post_authorships"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "post_authorships_author_idx" ON "post_authorships" USING btree ("oxy_user_id","status");--> statement-breakpoint
CREATE INDEX "post_classification_topic_refs_name_idx" ON "post_classification_topic_refs" USING btree ("name");--> statement-breakpoint
CREATE INDEX "post_classification_topic_refs_topic_id_idx" ON "post_classification_topic_refs" USING btree ("topic_id") WHERE "post_classification_topic_refs"."topic_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "post_content_variants_post_id_tag_key" ON "post_content_variants" USING btree ("post_id","tag") WHERE "post_content_variants"."tag" is not null;--> statement-breakpoint
CREATE INDEX "post_content_variants_search_gin" ON "post_content_variants" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "post_content_variants_primary_idx" ON "post_content_variants" USING btree ("post_id") WHERE "post_content_variants"."position" = 0;--> statement-breakpoint
CREATE INDEX "post_media_video_idx" ON "post_media" USING btree ("type","orientation","duration_sec");--> statement-breakpoint
CREATE INDEX "post_media_media_id_idx" ON "post_media" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "post_mentions_oxy_user_id_idx" ON "post_mentions" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "post_recent_repliers_post_idx" ON "post_recent_repliers" USING btree ("post_id","replied_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "posts_federation_activity_id_key" ON "posts" USING btree ("federation_activity_id") WHERE "posts"."federation_activity_id" is not null;--> statement-breakpoint
CREATE INDEX "post_public_chrono_v1" ON "posts" USING btree ("visibility","status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "post_replies_chrono_v1" ON "posts" USING btree ("parent_post_id","visibility","status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "post_links_chrono_v1" ON "posts" USING btree ("has_links","visibility","status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_owner_chrono_idx" ON "posts" USING btree ("oxy_user_id","visibility","status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_type_chrono_idx" ON "posts" USING btree ("type","visibility","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_created_at_idx" ON "posts" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_thread_idx" ON "posts" USING btree ("thread_id","oxy_user_id","parent_post_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_boost_of_idx" ON "posts" USING btree ("boost_of","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_quote_of_idx" ON "posts" USING btree ("quote_of","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_scheduled_idx" ON "posts" USING btree ("scheduled_for") WHERE "posts"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "posts_hashtags_gin" ON "posts" USING gin ("hashtags");--> statement-breakpoint
CREATE INDEX "posts_classification_topics_gin" ON "posts" USING gin ("classification_topics");--> statement-breakpoint
CREATE INDEX "posts_classification_languages_gin" ON "posts" USING gin ("classification_languages");--> statement-breakpoint
CREATE INDEX "posts_classification_region_idx" ON "posts" USING btree ("classification_region","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_classification_queue_idx" ON "posts" USING btree ("classification_status","created_at");--> statement-breakpoint
CREATE INDEX "posts_curated_idx" ON "posts" USING btree ("created_at" DESC NULLS LAST) WHERE "posts"."curated" is true;--> statement-breakpoint
CREATE INDEX "posts_geo_gist" ON "posts" USING gist ("geo");--> statement-breakpoint
CREATE INDEX "posts_content_geo_gist" ON "posts" USING gist ("content_geo");--> statement-breakpoint
CREATE INDEX "poll_votes_poll_id_idx" ON "poll_votes" USING btree ("poll_id");--> statement-breakpoint
CREATE INDEX "poll_votes_poll_id_user_id_idx" ON "poll_votes" USING btree ("poll_id","user_id");--> statement-breakpoint
CREATE INDEX "polls_created_by_idx" ON "polls" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "polls_ends_at_idx" ON "polls" USING btree ("ends_at");--> statement-breakpoint
CREATE INDEX "polls_post_id_idx" ON "polls" USING btree ("post_id") WHERE "polls"."post_id" is not null;--> statement-breakpoint
CREATE INDEX "user_behavior_authors_author_id_idx" ON "user_behavior_authors" USING btree ("author_id");