-- Native event attendance and Homiio case references.
--
-- 1. `event_attendance`: one row per (event post, Oxy account). NEW and empty;
--    `public` is false unless the attendee chooses to show it.
-- 2. `posts.content_event_capacity` / `_cancelled` / `_revision`: the organizer's
--    capacity, cancellation and an edit counter the notices cite.
--    `posts.content_homiio_case_id`: the only Homiio data a post keeps; the
--    browser resolves the card from Homiio's public API.
-- 3. `notifications.type` widens to `event_updated` / `event_cancelled`, and
--    `post_attachments.type` to `homiioCase`.
--
-- Safe during a rolling deploy: the previous release never names the new
-- columns (its inserts list columns explicitly, so they take their defaults),
-- and every CHECK either only widens or constrains a column that is NULL / 0 on
-- every existing row.
--
-- LOCK PROFILE. This migrator runs every pending file in ONE transaction, so
-- each lock is held to commit:
--  - `posts`: ACCESS EXCLUSIVE from ADD COLUMN / ADD CONSTRAINT, taken FIRST so
--    this migration acquires `posts` before the tables the write path locks
--    after it. Catalog-only: the columns are nullable or carry a constant
--    default (no rewrite), and the CHECKs are added NOT VALID, so no row of
--    `posts` is scanned under the lock.
--  - `notifications`, `post_attachments`: ACCESS EXCLUSIVE from DROP/ADD
--    CONSTRAINT, catalog-only for the same reason: each widened CHECK is NOT
--    VALID (`convalidated = false`) and every existing row satisfies it, since
--    each list is a superset of the one it replaces. New and updated rows are
--    checked as before.
-- Lock waits are bounded at 5 s so the migration fails rather than queueing
-- every reader of `posts` behind a long-running query; statements at 60 s. The
-- connection's prior timeouts are restored for any later migration.
SELECT set_config('mention.event_attendance_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.event_attendance_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "content_event_capacity" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "content_event_cancelled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "content_event_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "content_homiio_case_id" text;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_event_capacity_check" CHECK ("posts"."content_event_capacity" is null or "posts"."content_event_capacity" >= 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_event_revision_check" CHECK ("posts"."content_event_revision" >= 0) NOT VALID;--> statement-breakpoint
CREATE TABLE "event_attendance" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "event_attendance_post_user_key" UNIQUE("post_id","oxy_user_id")
);
--> statement-breakpoint
ALTER TABLE "event_attendance" ADD CONSTRAINT "event_attendance_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_attendance_account_idx" ON "event_attendance" USING btree ("oxy_user_id");--> statement-breakpoint
ALTER TABLE "post_attachments" DROP CONSTRAINT "post_attachments_type_check";--> statement-breakpoint
ALTER TABLE "post_attachments" ADD CONSTRAINT "post_attachments_type_check" CHECK ("post_attachments"."type" in ('media', 'poll', 'article', 'event', 'location', 'sources', 'room', 'podcast', 'homiioCase', 'job')) NOT VALID;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('like', 'reply', 'mention', 'follow', 'boost', 'quote', 'welcome', 'post', 'poke', 'collab_invite', 'collab_accepted', 'collab_declined', 'event_updated', 'event_cancelled')) NOT VALID;--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.event_attendance_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.event_attendance_statement_timeout'), true);
