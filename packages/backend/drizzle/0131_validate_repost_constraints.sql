-- oxy:deploy-phase=pre
-- Validates the foreign key added NOT VALID in 0126 and the two CHECKs added NOT VALID in 0130:
-- SHARE UPDATE EXCLUSIVE, so reads and writes keep going. The posts scan can take minutes.
-- oxy:statement-timeout=900s
ALTER TABLE "posts" VALIDATE CONSTRAINT "posts_repost_of_posts_id_fk";--> statement-breakpoint
ALTER TABLE "blocked_domain_purge_runs" VALIDATE CONSTRAINT "blocked_domain_purge_runs_removed_reposts_check";--> statement-breakpoint
ALTER TABLE "blocked_domain_purges" VALIDATE CONSTRAINT "blocked_domain_purges_measured_reposts_check";
