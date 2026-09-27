-- Instagram posts through Meta's Graph API (connectors/instagram/).
--
-- 1. `post_source_keys`: one Instagram post reached both through the Graph API
--    and through the kilogram.makeup bridge is ONE post (`instagram:<shortcode>`,
--    UNIQUE), whichever road arrives second; the Graph import CLAIMS a key before
--    re-hosting media so a racing bridge push cannot orphan an upload. A NEW
--    child table, not a `posts` column: the column plus its unique index on
--    `posts` would hold ACCESS EXCLUSIVE on `posts` for the whole index build —
--    this migrator runs every pending file in ONE transaction, so CONCURRENTLY is
--    unavailable and every read of `posts` would queue behind the build.
-- 2. `federated_media_deletions` (the durable outbox + tombstones for deleting
--    re-hosted federated media from Oxy) and `federated_media_posters` (the
--    poster frame uploaded with each re-hosted video): two NEW, empty tables.
-- 3. `instagram-graph` becomes a federation protocol (`federated_actors.protocol`,
--    `federated_follows.network`), and `federated_actors.instagram_graph_*` holds
--    the Graph sync's cooldown, lease, last result and pinned Instagram user id.
--
-- LOCK PROFILE — measured with `pg_locks` for this transaction's pid against a
-- database migrated to 0053 (2026-09-27), not assumed:
--  - `posts`: SHARE ROW EXCLUSIVE (plus ACCESS SHARE / ROW SHARE), from the
--    foreign key of the NEW, empty `post_source_keys` — taken FIRST, before any
--    federation-table DDL, so this migration acquires `posts` before the
--    federation tables the inbox path locks after it. Reads of `posts`
--    continue; writes wait only until this short transaction commits. No scan
--    and no index build touches `posts`.
--  - `federated_actors`, `federated_follows`: ACCESS EXCLUSIVE (ADD COLUMN and
--    DROP/ADD CONSTRAINT), held to commit, but every step on them is catalog-
--    only: the new columns are nullable without a default, and the widened
--    CHECKs are added NOT VALID (`convalidated = false`), so NO row is scanned
--    under that lock. Every existing row satisfies them — each list is a superset
--    of the one it replaces and the new column is NULL everywhere.
--    `scripts/backfillInstagramSourceKeys.ts` runs `VALIDATE CONSTRAINT` after
--    the deploy, under SHARE UPDATE EXCLUSIVE (reads and writes continue).
-- Lock waits are bounded at 5 s so the migration fails rather than queueing
-- every reader of these tables behind a long-running query; statements at 60 s.
-- The connection's prior timeouts are restored for any later migration.
SELECT set_config('mention.instagram_graph_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.instagram_graph_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE TABLE "post_source_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"post_id" text,
	"claimed_until" timestamp with time zone,
	"claim_token" text,
	"missing_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "post_source_keys_source_key_key" UNIQUE("source_key"),
	CONSTRAINT "post_source_keys_post_id_key" UNIQUE("post_id"),
	CONSTRAINT "post_source_keys_claim_shape_check" CHECK (("post_source_keys"."post_id" is not null and "post_source_keys"."claimed_until" is null and "post_source_keys"."claim_token" is null)
        or ("post_source_keys"."post_id" is null and "post_source_keys"."claimed_until" is not null and "post_source_keys"."claim_token" is not null))
);
--> statement-breakpoint
ALTER TABLE "post_source_keys" ADD CONSTRAINT "post_source_keys_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "federated_media_deletions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_file_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "federated_media_deletions_oxy_file_id_key" UNIQUE("oxy_file_id"),
	CONSTRAINT "federated_media_deletions_state_check" CHECK ("federated_media_deletions"."state" in ('pending', 'deleting', 'deleted', 'not_found', 'forbidden', 'in_use'))
);
--> statement-breakpoint
CREATE TABLE "federated_media_posters" (
	"id" text PRIMARY KEY NOT NULL,
	"video_file_id" text NOT NULL,
	"poster_file_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "federated_media_posters_video_poster_key" UNIQUE("video_file_id","poster_file_id")
);
--> statement-breakpoint
CREATE INDEX "federated_media_deletions_due_idx" ON "federated_media_deletions" USING btree ("next_attempt_at") WHERE "federated_media_deletions"."state" in ('pending', 'deleting');
--> statement-breakpoint
CREATE INDEX "federated_media_posters_poster_file_id_idx" ON "federated_media_posters" USING btree ("poster_file_id");
--> statement-breakpoint
ALTER TABLE "federated_actors" DROP CONSTRAINT "federated_actors_protocol_check";
--> statement-breakpoint
ALTER TABLE "federated_follows" DROP CONSTRAINT "federated_follows_network_check";
--> statement-breakpoint
ALTER TABLE "federated_actors" ADD COLUMN "instagram_graph_synced_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "federated_actors" ADD COLUMN "instagram_graph_sync_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "federated_actors" ADD COLUMN "instagram_graph_last_result" text;
--> statement-breakpoint
ALTER TABLE "federated_actors" ADD COLUMN "instagram_graph_user_id" text;
--> statement-breakpoint
ALTER TABLE "federated_actors" ADD COLUMN "instagram_graph_history_depth" integer;
--> statement-breakpoint
ALTER TABLE "federated_actors" ADD CONSTRAINT "federated_actors_instagram_graph_last_result_check" CHECK ("federated_actors"."instagram_graph_last_result" is null or "federated_actors"."instagram_graph_last_result" in ('ok', 'not_business', 'identity_mismatch', 'error', 'deadline')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "federated_actors" ADD CONSTRAINT "federated_actors_protocol_check" CHECK ("federated_actors"."protocol" in ('activitypub', 'atproto', 'instagram-graph')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "federated_follows" ADD CONSTRAINT "federated_follows_network_check" CHECK ("federated_follows"."network" in ('activitypub', 'atproto', 'instagram-graph')) NOT VALID;
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.instagram_graph_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.instagram_graph_statement_timeout'), true);
