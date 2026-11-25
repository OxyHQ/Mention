-- oxy:deploy-phase=post
-- CONTRACT phase for the hot posts table, alone in its file (docs/repost-rename.md): the sync
-- trigger goes, then the four old columns (their foreign key, CHECK-free indexes and the old
-- indexes drop with them), then the two `_v2` indexes take back the names of the indexes that
-- just went. Dropping a column is a catalog change; the lock is brief and the migrator retries.
DROP TRIGGER "posts_sync_repost_columns" ON "posts";--> statement-breakpoint
DROP FUNCTION "posts_sync_repost_columns"();--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "boost_of";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "stats_boosts_count";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "stats_federated_boosts_count";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "metadata_is_boosted";--> statement-breakpoint
ALTER INDEX "posts_public_originals_recent_v2_idx" RENAME TO "posts_public_originals_recent_idx";--> statement-breakpoint
ALTER INDEX "posts_engagement_rank_v2_idx" RENAME TO "posts_engagement_rank_idx";
