CREATE TABLE "event_attendance" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "event_attendance_post_user_key" UNIQUE("post_id","oxy_user_id")
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_check";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "content_event_capacity" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "content_event_cancelled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "content_event_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "event_attendance" ADD CONSTRAINT "event_attendance_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_attendance_account_idx" ON "event_attendance" USING btree ("oxy_user_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('like', 'reply', 'mention', 'follow', 'boost', 'quote', 'welcome', 'post', 'poke', 'collab_invite', 'collab_accepted', 'collab_declined', 'event_updated', 'event_cancelled'));--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_event_capacity_check" CHECK ("posts"."content_event_capacity" is null or "posts"."content_event_capacity" >= 1);--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_event_revision_check" CHECK ("posts"."content_event_revision" >= 0);