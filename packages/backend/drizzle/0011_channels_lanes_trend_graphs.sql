CREATE TABLE "channel_follows" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"notify" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "channel_follows_oxy_user_id_channel_id_key" UNIQUE("oxy_user_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "channel_members" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"role" text DEFAULT 'publisher' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by_oxy_user_id" text,
	"invited_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "channel_members_channel_id_oxy_user_id_key" UNIQUE("channel_id","oxy_user_id"),
	CONSTRAINT "channel_members_role_check" CHECK ("channel_members"."role" in ('owner', 'publisher')),
	CONSTRAINT "channel_members_status_check" CHECK ("channel_members"."status" in ('pending', 'accepted', 'declined', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"handle_lower" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"avatar" text,
	"banner" text,
	"owner_oxy_user_id" text NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"sign_posts" boolean DEFAULT false NOT NULL,
	"follower_count" integer DEFAULT 0 NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"post_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "channels_visibility_check" CHECK ("channels"."visibility" in ('public')),
	CONSTRAINT "channels_counts_check" CHECK ("channels"."follower_count" >= 0 and "channels"."member_count" >= 0 and "channels"."post_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lane_mutes" (
	"id" text PRIMARY KEY NOT NULL,
	"viewer_oxy_user_id" text NOT NULL,
	"lane_id" text NOT NULL,
	"lane_owner_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "lane_mutes_viewer_lane_key" UNIQUE("viewer_oxy_user_id","lane_id")
);
--> statement-breakpoint
CREATE TABLE "lanes" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"name_lower" text NOT NULL,
	"display_mode" text DEFAULT 'mixed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "lanes_owner_name_lower_key" UNIQUE("owner_type","owner_id","name_lower"),
	CONSTRAINT "lanes_owner_type_check" CHECK ("lanes"."owner_type" in ('user', 'channel')),
	CONSTRAINT "lanes_display_mode_check" CHECK ("lanes"."display_mode" in ('mixed', 'tab', 'hidden'))
);
--> statement-breakpoint
CREATE TABLE "trend_graphs" (
	"id" text PRIMARY KEY NOT NULL,
	"calculated_at" timestamp with time zone NOT NULL,
	"nodes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dropped_edges" integer,
	CONSTRAINT "trend_graphs_calculated_at_key" UNIQUE("calculated_at"),
	CONSTRAINT "trend_graphs_dropped_edges_check" CHECK ("trend_graphs"."dropped_edges" is null or "trend_graphs"."dropped_edges" >= 0)
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_check";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_entity_type_check";--> statement-breakpoint
ALTER TABLE "trending" ADD COLUMN "terms" text[];--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "lane_id" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "channel_follows" ADD CONSTRAINT "channel_follows_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_mutes" ADD CONSTRAINT "lane_mutes_lane_id_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_follows_by_user_idx" ON "channel_follows" USING btree ("oxy_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "channel_follows_channel_notify_idx" ON "channel_follows" USING btree ("channel_id","notify","id");--> statement-breakpoint
CREATE INDEX "channel_members_channel_status_idx" ON "channel_members" USING btree ("channel_id","status");--> statement-breakpoint
CREATE INDEX "channel_members_user_status_idx" ON "channel_members" USING btree ("oxy_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_handle_lower_key" ON "channels" USING btree ("handle_lower");--> statement-breakpoint
CREATE INDEX "channels_owner_chrono_idx" ON "channels" USING btree ("owner_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "channels_directory_idx" ON "channels" USING btree ("visibility","follower_count" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "lane_mutes_viewer_chrono_idx" ON "lane_mutes" USING btree ("viewer_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "lanes_owner_idx" ON "lanes" USING btree ("owner_type","owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_lane_id_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_lane_chrono_v1" ON "posts" USING btree ("lane_id","visibility","status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "posts"."lane_id" is not null;--> statement-breakpoint
CREATE INDEX "post_channel_chrono_v1" ON "posts" USING btree ("channel_id","visibility","status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "posts"."channel_id" is not null;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('like', 'reply', 'mention', 'follow', 'boost', 'quote', 'welcome', 'post', 'poke', 'collab_invite', 'collab_accepted', 'collab_declined', 'channel_invite'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_entity_type_check" CHECK ("notifications"."entity_type" in ('post', 'reply', 'profile', 'channel'));