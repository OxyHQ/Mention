-- oxy:deploy-phase=pre
-- Validates the CHECKs widened in 0135-0138: SHARE UPDATE EXCLUSIVE, reads and writes keep going.
-- oxy:statement-timeout=900s
ALTER TABLE "feed_interactions" VALIDATE CONSTRAINT "feed_interactions_event_check";--> statement-breakpoint
ALTER TABLE "federation_post_import_reasons" VALIDATE CONSTRAINT "federation_post_import_reasons_reason_check";--> statement-breakpoint
ALTER TABLE "federation_post_imports" VALIDATE CONSTRAINT "federation_post_imports_reason_check";--> statement-breakpoint
ALTER TABLE "posts" VALIDATE CONSTRAINT "posts_type_check";--> statement-breakpoint
ALTER TABLE "notifications" VALIDATE CONSTRAINT "notifications_type_check";
