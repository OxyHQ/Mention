-- oxy:deploy-phase=pre
ALTER TABLE "oxy_file_reference_reconciliations" DROP CONSTRAINT "oxy_file_reference_reconciliations_entity_type_check";--> statement-breakpoint
ALTER TABLE "oxy_file_reference_sync" DROP CONSTRAINT "oxy_file_reference_sync_entity_type_check";--> statement-breakpoint
ALTER TABLE "membership_communities" ALTER COLUMN "description" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "membership_tiers" ALTER COLUMN "description" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "oxy_file_reference_reconciliations" ADD CONSTRAINT "oxy_file_reference_reconciliations_entity_type_check" CHECK ("oxy_file_reference_reconciliations"."entity_type" in ('post', 'gif', 'profile_banner', 'video_poster', 'job_application', 'moderation_report', 'membership_media')) NOT VALID;--> statement-breakpoint
ALTER TABLE "oxy_file_reference_sync" ADD CONSTRAINT "oxy_file_reference_sync_entity_type_check" CHECK ("oxy_file_reference_sync"."entity_type" in ('post', 'gif', 'profile_banner', 'video_poster', 'job_application', 'moderation_report', 'membership_media')) NOT VALID;
--> statement-breakpoint
CREATE FUNCTION "membership_media_file_references"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM mention_mark_file_reference(OLD.file_id, 'membership_media', OLD.id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM mention_mark_file_reference(NEW.file_id, 'membership_media', NEW.id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "membership_media_file_references"
AFTER INSERT OR DELETE ON "membership_media"
FOR EACH ROW EXECUTE FUNCTION "membership_media_file_references"();
--> statement-breakpoint
CREATE TRIGGER "membership_media_file_references_update"
AFTER UPDATE OF "file_id" ON "membership_media"
FOR EACH ROW
WHEN (OLD.file_id IS DISTINCT FROM NEW.file_id)
EXECUTE FUNCTION "membership_media_file_references"();
