-- oxy:deploy-phase=post
-- CONTRACT phase for user_settings, a hot table, alone in its file (docs/repost-rename.md).
DROP TRIGGER "user_settings_sync_repost_columns" ON "user_settings";--> statement-breakpoint
DROP FUNCTION "user_settings_sync_repost_columns"();--> statement-breakpoint
ALTER TABLE "user_settings" DROP COLUMN "notify_boosts";
