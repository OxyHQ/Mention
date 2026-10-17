-- oxy:deploy-phase=post
-- Telegram joins the import platforms, and the ledger records WHERE an item
-- came from in structured form.
--
-- `platform` widens to `telegram` (`IMPORT_PLATFORMS` in shared-types): a
-- Telegram channel export becomes the channel's own posts, recorded here like
-- any other import, so dedupe, undo and "Originally posted on Telegram" work
-- unchanged.
--
-- `source_account_id` / `source_item_id` name the source account and the item
-- within it as the platform does (a Telegram channel id and message id, a
-- Mastodon actor and status id, a Bluesky DID and record key). They are
-- provenance, not the dedupe key: `source_id` stays that.
--
-- Safe during a rolling deploy: two NULLABLE columns the previous release never
-- names (its inserts list columns explicitly, so the new ones read NULL), and a
-- CHECK that only widens. Swapping the CHECK takes a brief ACCESS EXCLUSIVE lock
-- on a small table.
ALTER TABLE "post_imports" DROP CONSTRAINT "post_imports_platform_check";--> statement-breakpoint
ALTER TABLE "post_imports" ADD COLUMN "source_account_id" text;--> statement-breakpoint
ALTER TABLE "post_imports" ADD COLUMN "source_item_id" text;--> statement-breakpoint
ALTER TABLE "post_imports" ADD CONSTRAINT "post_imports_platform_check" CHECK ("post_imports"."platform" in ('mastodon', 'bluesky', 'threads', 'instagram', 'x', 'facebook', 'medium', 'substack', 'telegram'));
