-- oxy:deploy-phase=pre
-- Metadata-only constant default; existing viewers keep chronological Following.
ALTER TABLE "user_settings" ADD COLUMN "feed_following_sort" text DEFAULT 'chronological' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_following_sort_check" CHECK ("user_settings"."feed_following_sort" in ('chronological', 'relevance'));