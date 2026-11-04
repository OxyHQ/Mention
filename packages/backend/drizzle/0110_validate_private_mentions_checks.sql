-- oxy:deploy-phase=pre
-- Validate the two CHECKs `0109_private_mentions` re-added NOT VALID. Nothing
-- else: `VALIDATE CONSTRAINT` takes SHARE UPDATE EXCLUSIVE, so reads and writes
-- keep going while `posts` and `notifications` are scanned. Every existing row
-- satisfies both: each widened list is a superset of the one it replaced.
ALTER TABLE "posts" VALIDATE CONSTRAINT "posts_visibility_check";--> statement-breakpoint
ALTER TABLE "notifications" VALIDATE CONSTRAINT "notifications_type_check";
