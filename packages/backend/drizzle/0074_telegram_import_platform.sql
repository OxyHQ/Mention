-- Telegram joins the import platforms (`IMPORT_PLATFORMS` in shared-types).
--
-- A Telegram channel export becomes the channel's own posts, recorded in the
-- ledger like any other import so dedupe, undo and the "Originally posted on
-- Telegram" label work unchanged. Only the CHECK widens; no row is touched, and
-- swapping a CHECK on a small table is a brief ACCESS EXCLUSIVE lock.
ALTER TABLE "post_imports" DROP CONSTRAINT "post_imports_platform_check";--> statement-breakpoint
ALTER TABLE "post_imports" ADD CONSTRAINT "post_imports_platform_check" CHECK ("post_imports"."platform" in ('mastodon', 'bluesky', 'threads', 'instagram', 'x', 'facebook', 'medium', 'substack', 'telegram'));
