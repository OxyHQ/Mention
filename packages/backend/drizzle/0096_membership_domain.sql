-- oxy:deploy-phase=pre
CREATE TABLE "community_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"community_id" text NOT NULL,
	"member_oxy_user_id" text NOT NULL,
	"tier_id" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"public_badge" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"access_ends_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "community_memberships_account_key" UNIQUE("community_id","member_oxy_user_id"),
	CONSTRAINT "community_memberships_state_check" CHECK ("community_memberships"."state" in ('active', 'grace_period', 'cancelled', 'expired', 'refunded', 'revoked')),
	CONSTRAINT "community_memberships_grace_end_check" CHECK ("community_memberships"."state" <> 'grace_period' or "community_memberships"."access_ends_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "membership_communities" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_oxy_user_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "membership_communities_slug_key" UNIQUE("slug"),
	CONSTRAINT "membership_communities_visibility_check" CHECK ("membership_communities"."visibility" in ('public', 'unlisted')),
	CONSTRAINT "membership_communities_status_check" CHECK ("membership_communities"."status" in ('draft', 'active', 'paused', 'closed', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "membership_content_tiers" (
	"community_id" text NOT NULL,
	"content_id" text NOT NULL,
	"tier_id" text NOT NULL,
	CONSTRAINT "membership_content_tiers_content_id_tier_id_pk" PRIMARY KEY("content_id","tier_id")
);
--> statement-breakpoint
CREATE TABLE "membership_contents" (
	"id" text PRIMARY KEY NOT NULL,
	"community_id" text NOT NULL,
	"author_oxy_user_id" text NOT NULL,
	"parent_content_id" text,
	"kind" text NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"teaser" text,
	"removed_at" timestamp with time zone,
	"poll_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "membership_contents_id_community_key" UNIQUE("id","community_id"),
	CONSTRAINT "membership_contents_kind_check" CHECK ("membership_contents"."kind" in ('post', 'article', 'discussion', 'poll')),
	CONSTRAINT "membership_contents_poll_end_check" CHECK (("membership_contents"."kind" = 'poll') = ("membership_contents"."poll_ends_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "membership_media" (
	"id" text PRIMARY KEY NOT NULL,
	"community_id" text NOT NULL,
	"content_id" text,
	"owner_oxy_user_id" text NOT NULL,
	"file_id" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "membership_media_size_check" CHECK ("membership_media"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "membership_poll_options" (
	"id" text PRIMARY KEY NOT NULL,
	"content_id" text NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "membership_poll_options_position_key" UNIQUE("content_id","position"),
	CONSTRAINT "membership_poll_options_content_key" UNIQUE("id","content_id"),
	CONSTRAINT "membership_poll_options_position_check" CHECK ("membership_poll_options"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "membership_poll_votes" (
	"id" text PRIMARY KEY NOT NULL,
	"content_id" text NOT NULL,
	"voter_oxy_user_id" text NOT NULL,
	"option_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "membership_poll_votes_member_key" UNIQUE("content_id","voter_oxy_user_id")
);
--> statement-breakpoint
CREATE TABLE "membership_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"content_id" text NOT NULL,
	"reporter_oxy_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "membership_reports_reporter_key" UNIQUE("content_id","reporter_oxy_user_id")
);
--> statement-breakpoint
CREATE TABLE "membership_tier_benefits" (
	"tier_id" text NOT NULL,
	"benefit" text NOT NULL,
	CONSTRAINT "membership_tier_benefits_tier_id_benefit_pk" PRIMARY KEY("tier_id","benefit"),
	CONSTRAINT "membership_tier_benefits_benefit_check" CHECK ("membership_tier_benefits"."benefit" in ('content_read', 'discussion_write', 'polls_vote', 'media_download'))
);
--> statement-breakpoint
CREATE TABLE "membership_tiers" (
	"id" text PRIMARY KEY NOT NULL,
	"community_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "membership_tiers_id_community_key" UNIQUE("id","community_id"),
	CONSTRAINT "membership_tiers_kind_check" CHECK ("membership_tiers"."kind" in ('free', 'paid')),
	CONSTRAINT "membership_tiers_status_check" CHECK ("membership_tiers"."status" in ('draft', 'active', 'retired')),
	CONSTRAINT "membership_tiers_paid_draft_check" CHECK ("membership_tiers"."kind" <> 'paid' or "membership_tiers"."status" <> 'active')
);
--> statement-breakpoint
ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_community_id_membership_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."membership_communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_tier_id_community_id_membership_tiers_id_community_id_fk" FOREIGN KEY ("tier_id","community_id") REFERENCES "public"."membership_tiers"("id","community_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_content_tiers" ADD CONSTRAINT "membership_content_tiers_community_id_membership_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."membership_communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_content_tiers" ADD CONSTRAINT "membership_content_tiers_content_id_membership_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."membership_contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_content_tiers" ADD CONSTRAINT "membership_content_tiers_tier_id_membership_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_content_tiers" ADD CONSTRAINT "membership_content_tiers_content_id_community_id_membership_contents_id_community_id_fk" FOREIGN KEY ("content_id","community_id") REFERENCES "public"."membership_contents"("id","community_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_content_tiers" ADD CONSTRAINT "membership_content_tiers_tier_id_community_id_membership_tiers_id_community_id_fk" FOREIGN KEY ("tier_id","community_id") REFERENCES "public"."membership_tiers"("id","community_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_contents" ADD CONSTRAINT "membership_contents_community_id_membership_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."membership_communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_contents" ADD CONSTRAINT "membership_contents_parent_content_id_community_id_membership_contents_id_community_id_fk" FOREIGN KEY ("parent_content_id","community_id") REFERENCES "public"."membership_contents"("id","community_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_media" ADD CONSTRAINT "membership_media_community_id_membership_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."membership_communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_media" ADD CONSTRAINT "membership_media_content_id_membership_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."membership_contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_media" ADD CONSTRAINT "membership_media_content_id_community_id_membership_contents_id_community_id_fk" FOREIGN KEY ("content_id","community_id") REFERENCES "public"."membership_contents"("id","community_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_poll_options" ADD CONSTRAINT "membership_poll_options_content_id_membership_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."membership_contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_poll_votes" ADD CONSTRAINT "membership_poll_votes_content_id_membership_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."membership_contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_poll_votes" ADD CONSTRAINT "membership_poll_votes_option_id_content_id_membership_poll_options_id_content_id_fk" FOREIGN KEY ("option_id","content_id") REFERENCES "public"."membership_poll_options"("id","content_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_reports" ADD CONSTRAINT "membership_reports_content_id_membership_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."membership_contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_tier_benefits" ADD CONSTRAINT "membership_tier_benefits_tier_id_membership_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD CONSTRAINT "membership_tiers_community_id_membership_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."membership_communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_memberships_member_idx" ON "community_memberships" USING btree ("member_oxy_user_id");--> statement-breakpoint
CREATE INDEX "community_memberships_tier_idx" ON "community_memberships" USING btree ("tier_id");--> statement-breakpoint
CREATE INDEX "membership_communities_owner_idx" ON "membership_communities" USING btree ("owner_oxy_user_id");--> statement-breakpoint
CREATE INDEX "membership_content_tiers_tier_idx" ON "membership_content_tiers" USING btree ("tier_id");--> statement-breakpoint
CREATE INDEX "membership_contents_community_page_idx" ON "membership_contents" USING btree ("community_id","created_at","id");--> statement-breakpoint
CREATE INDEX "membership_contents_author_idx" ON "membership_contents" USING btree ("author_oxy_user_id");--> statement-breakpoint
CREATE INDEX "membership_contents_parent_idx" ON "membership_contents" USING btree ("parent_content_id");--> statement-breakpoint
CREATE INDEX "membership_media_content_idx" ON "membership_media" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX "membership_media_community_idx" ON "membership_media" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "membership_media_owner_idx" ON "membership_media" USING btree ("owner_oxy_user_id");--> statement-breakpoint
CREATE INDEX "membership_poll_votes_voter_idx" ON "membership_poll_votes" USING btree ("voter_oxy_user_id");--> statement-breakpoint
CREATE INDEX "membership_poll_votes_option_idx" ON "membership_poll_votes" USING btree ("option_id");--> statement-breakpoint
CREATE INDEX "membership_reports_reporter_idx" ON "membership_reports" USING btree ("reporter_oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_tiers_one_free_idx" ON "membership_tiers" USING btree ("community_id") WHERE "membership_tiers"."kind" = 'free' and "membership_tiers"."status" <> 'retired';--> statement-breakpoint
CREATE INDEX "membership_tiers_community_idx" ON "membership_tiers" USING btree ("community_id");