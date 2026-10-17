-- Oxy Files: who owns a file, who uses it, and when it goes away (ADR 0043,
-- docs/oxy-files.md).
--
-- Mention now tells Oxy which files it USES: every (file, entity) pair is an
-- Oxy file reference registered with Mention's service token. This migration
-- adds the bookkeeping for that and the triggers that keep it complete:
--
--   oxy_file_reference_sync          the outbox. The triggers below mark a
--                                    (file, entity type, entity) pair dirty in
--                                    the transaction that changed it; the drain
--                                    (services/oxyFiles/fileReferenceSync.ts)
--                                    decides add/remove from the current data.
--   oxy_file_reference_reconciliations  the nightly reconciliation's history.
--   oxy_file_events / oxy_file_states   Oxy's file events (audit + dedupe) and
--                                    the withholding they leave each file in.
--   gif_cache_file_retirements       the GIF library's old federation-cache
--                                    files, owed a delete by the move to
--                                    application-owned files.
--   moderation_report_evidence_files the application-owned copies of a
--                                    reported post's media sent to CrowdSource
--                                    as evidence (written once per report).
--   gifs.storage                     'federation_cache' for every existing row
--                                    (and for a row the previous image inserts
--                                    during the deploy — the DEFAULT); new
--                                    imports write 'application'.
--   reports.envelope_version         which envelope shape a report is delivered
--                                    with, fixed at its first attempt (a report
--                                    first attempted before media evidence keeps
--                                    the shape it was first sent with).
--   post_media.withheld,             the copy of oxy_file_states.withheld a
--   post_variant_media.withheld      reader filters on.
--
-- WHY TRIGGERS. A file id reaches these tables through ~20 write paths (post
-- create and edit, federation inbound, imports, the media enrich job) and
-- leaves them through as many more, several of them `ON DELETE CASCADE` from
-- `posts` (account erasure, channel deletion, scripts) that never pass through
-- application code. Marking in the database is the one place none of them can
-- skip, and it commits or rolls back with the change itself.
--
-- The new CHECKs on post_media and post_variant_media are NOT VALID: the column
-- is new, so every existing row is NULL and satisfies them; validating would
-- scan both tables while ADD COLUMN's ACCESS EXCLUSIVE lock is held. New and
-- updated rows are checked.
--
-- CREATE TRIGGER and ADD COLUMN wait for in-flight writes to the media tables;
-- refuse after 5 s rather than queue every later write behind them.
SELECT set_config('mention.oxy_file_references_lock_timeout', current_setting('lock_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "moderation_report_evidence_files" (
	"report_id" text NOT NULL,
	"position" integer NOT NULL,
	"source_file_id" text NOT NULL,
	"evidence_file_id" text,
	"media_type" text NOT NULL,
	"mime_type" text,
	"sha256" text,
	"size_bytes" integer,
	"width" integer,
	"height" integer,
	"duration_seconds" double precision,
	"source_url" text,
	"unavailable_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_report_evidence_files_pkey" PRIMARY KEY("report_id","position"),
	CONSTRAINT "moderation_report_evidence_files_media_type_check" CHECK ("moderation_report_evidence_files"."media_type" in ('image', 'video', 'gif')),
	CONSTRAINT "moderation_report_evidence_files_copy_check" CHECK (("moderation_report_evidence_files"."evidence_file_id" is not null and "moderation_report_evidence_files"."sha256" is not null and "moderation_report_evidence_files"."mime_type" is not null)
        or ("moderation_report_evidence_files"."evidence_file_id" is null and "moderation_report_evidence_files"."unavailable_reason" is not null)),
	CONSTRAINT "moderation_report_evidence_files_position_check" CHECK ("moderation_report_evidence_files"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "gif_cache_file_retirements" (
	"old_file_id" text PRIMARY KEY NOT NULL,
	"gif_id" text,
	"new_file_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "gif_cache_file_retirements_state_check" CHECK ("gif_cache_file_retirements"."state" in ('pending', 'deleted', 'not_found', 'kept')),
	CONSTRAINT "gif_cache_file_retirements_attempts_check" CHECK ("gif_cache_file_retirements"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "oxy_file_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"file_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"file_status" text NOT NULL,
	"file_visibility" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"applied" boolean NOT NULL,
	"withheld" text,
	"references_listed" integer DEFAULT 0 NOT NULL,
	"media_rows_changed" integer DEFAULT 0 NOT NULL,
	"gifs_removed" integer DEFAULT 0 NOT NULL,
	"banners_cleared" integer DEFAULT 0 NOT NULL,
	"resumes_cleared" integer DEFAULT 0 NOT NULL,
	"references_resent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_events_type_check" CHECK ("oxy_file_events"."type" in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked')),
	CONSTRAINT "oxy_file_events_owner_kind_check" CHECK ("oxy_file_events"."owner_kind" in ('account', 'application', 'platform')),
	CONSTRAINT "oxy_file_events_withheld_check" CHECK ("oxy_file_events"."withheld" is null or "oxy_file_events"."withheld" in ('deleted', 'blocked', 'trashed', 'private'))
);
--> statement-breakpoint
CREATE TABLE "oxy_file_reference_reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"oxy_entity_type" text NOT NULL,
	"mode" text NOT NULL,
	"outcome" text DEFAULT 'running' NOT NULL,
	"items" integer,
	"added" integer,
	"removed" integer,
	"unchanged" integer,
	"refused" integer,
	"replayed" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "oxy_file_reference_reconciliations_entity_type_check" CHECK ("oxy_file_reference_reconciliations"."entity_type" in ('post', 'gif', 'profile_banner', 'video_poster', 'job_application', 'moderation_report')),
	CONSTRAINT "oxy_file_reference_reconciliations_mode_check" CHECK ("oxy_file_reference_reconciliations"."mode" in ('dry_run', 'apply')),
	CONSTRAINT "oxy_file_reference_reconciliations_outcome_check" CHECK ("oxy_file_reference_reconciliations"."outcome" in ('running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "oxy_file_reference_sync" (
	"file_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"synced_op" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"synced_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_reference_sync_pkey" PRIMARY KEY("file_id","entity_type","entity_id"),
	CONSTRAINT "oxy_file_reference_sync_entity_type_check" CHECK ("oxy_file_reference_sync"."entity_type" in ('post', 'gif', 'profile_banner', 'video_poster', 'job_application', 'moderation_report')),
	CONSTRAINT "oxy_file_reference_sync_state_check" CHECK ("oxy_file_reference_sync"."state" in ('pending', 'synced', 'refused')),
	CONSTRAINT "oxy_file_reference_sync_synced_op_check" CHECK ("oxy_file_reference_sync"."synced_op" is null or "oxy_file_reference_sync"."synced_op" in ('add', 'remove')),
	CONSTRAINT "oxy_file_reference_sync_counts_check" CHECK ("oxy_file_reference_sync"."attempts" >= 0 and "oxy_file_reference_sync"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "oxy_file_states" (
	"file_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"visibility" text NOT NULL,
	"withheld" text,
	"last_event_id" text NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_states_withheld_check" CHECK ("oxy_file_states"."withheld" is null or "oxy_file_states"."withheld" in ('deleted', 'blocked', 'trashed', 'private')),
	CONSTRAINT "oxy_file_states_expiry_check" CHECK ("oxy_file_states"."withheld" is null or "oxy_file_states"."expires_at" is null)
);
--> statement-breakpoint
ALTER TABLE "gifs" ADD COLUMN "storage" text DEFAULT 'federation_cache' NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "envelope_version" integer;--> statement-breakpoint
ALTER TABLE "post_media" ADD COLUMN "withheld" text;--> statement-breakpoint
ALTER TABLE "post_variant_media" ADD COLUMN "withheld" text;--> statement-breakpoint
ALTER TABLE "moderation_report_evidence_files" ADD CONSTRAINT "moderation_report_evidence_files_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gif_cache_file_retirements" ADD CONSTRAINT "gif_cache_file_retirements_gif_id_gifs_id_fk" FOREIGN KEY ("gif_id") REFERENCES "public"."gifs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oxy_file_events_file_id_idx" ON "oxy_file_events" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "oxy_file_events_created_at_idx" ON "oxy_file_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "oxy_file_reference_reconciliations_started_at_idx" ON "oxy_file_reference_reconciliations" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "oxy_file_reference_sync_due_idx" ON "oxy_file_reference_sync" USING btree ("next_attempt_at") WHERE "oxy_file_reference_sync"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "oxy_file_reference_sync_removed_idx" ON "oxy_file_reference_sync" USING btree ("entity_type","synced_at") WHERE "oxy_file_reference_sync"."synced_op" = 'remove';--> statement-breakpoint
CREATE INDEX "oxy_file_reference_sync_expires_at_idx" ON "oxy_file_reference_sync" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oxy_file_states_expires_at_idx" ON "oxy_file_states" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "gifs" ADD CONSTRAINT "gifs_storage_check" CHECK ("gifs"."storage" in ('federation_cache', 'application'));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_envelope_version_check" CHECK ("reports"."envelope_version" is null or "reports"."envelope_version" in (1, 2));--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_withheld_check" CHECK ("post_media"."withheld" is null or "post_media"."withheld" in ('deleted', 'blocked', 'trashed', 'private')) NOT VALID;--> statement-breakpoint
ALTER TABLE "post_variant_media" ADD CONSTRAINT "post_variant_media_withheld_check" CHECK ("post_variant_media"."withheld" is null or "post_variant_media"."withheld" in ('deleted', 'blocked', 'trashed', 'private')) NOT VALID;--> statement-breakpoint
-- Mark one (file, entity type, entity) pair dirty for the reference drain.
-- Anything that is not an Oxy file id is ignored, by the same rule as
-- `isOxyFileId` (services/postMediaVisibility.ts): blank, a client temp id or
-- an absolute http(s) URL (federated media not re-hosted). A pending row keeps
-- its backoff; a settled one is due again now.
CREATE FUNCTION "mention_mark_file_reference"(p_file_id text, p_entity_type text, p_entity_id text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_file_id IS NULL OR p_entity_id IS NULL
    OR btrim(p_file_id) = ''
    OR p_file_id LIKE 'temp-%'
    OR p_file_id ~* '^https?://'
  THEN
    RETURN;
  END IF;
  INSERT INTO oxy_file_reference_sync AS s (file_id, entity_type, entity_id)
  VALUES (p_file_id, p_entity_type, p_entity_id)
  ON CONFLICT (file_id, entity_type, entity_id) DO UPDATE SET
    generation = s.generation + 1,
    state = 'pending',
    next_attempt_at = CASE WHEN s.state = 'pending' THEN s.next_attempt_at ELSE now() END,
    attempts = CASE WHEN s.state = 'pending' THEN s.attempts ELSE 0 END,
    expires_at = NULL,
    updated_at = date_trunc('milliseconds', now());
END;
$$;
--> statement-breakpoint
-- `post`: a post's shared media.
CREATE FUNCTION "post_media_file_references"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM mention_mark_file_reference(OLD.media_id, 'post', OLD.post_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM mention_mark_file_reference(NEW.media_id, 'post', NEW.post_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "post_media_file_references"
AFTER INSERT OR DELETE ON "post_media"
FOR EACH ROW EXECUTE FUNCTION "post_media_file_references"();
--> statement-breakpoint
CREATE TRIGGER "post_media_file_references_update"
AFTER UPDATE OF "media_id", "post_id" ON "post_media"
FOR EACH ROW
WHEN ((OLD.media_id, OLD.post_id) IS DISTINCT FROM (NEW.media_id, NEW.post_id))
EXECUTE FUNCTION "post_media_file_references"();
--> statement-breakpoint
-- `post`: a language variant's media override, under its POST (variants are
-- re-created on every edit, so the variant id is no stable entity). A row
-- whose variant is already gone is a cascade from that variant, which marked
-- it on its way out (`post_content_variants_file_references` below).
CREATE FUNCTION "post_variant_media_file_references"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_post_id text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT post_id INTO v_post_id FROM post_content_variants WHERE id = OLD.variant_id;
    IF FOUND THEN
      PERFORM mention_mark_file_reference(OLD.media_id, 'post', v_post_id);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT post_id INTO v_post_id FROM post_content_variants WHERE id = NEW.variant_id;
    IF FOUND THEN
      PERFORM mention_mark_file_reference(NEW.media_id, 'post', v_post_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "post_variant_media_file_references"
AFTER INSERT OR DELETE ON "post_variant_media"
FOR EACH ROW EXECUTE FUNCTION "post_variant_media_file_references"();
--> statement-breakpoint
CREATE TRIGGER "post_variant_media_file_references_update"
AFTER UPDATE OF "media_id", "variant_id" ON "post_variant_media"
FOR EACH ROW
WHEN ((OLD.media_id, OLD.variant_id) IS DISTINCT FROM (NEW.media_id, NEW.variant_id))
EXECUTE FUNCTION "post_variant_media_file_references"();
--> statement-breakpoint
-- BEFORE the variant goes, while its media rows (deleted next by the cascade)
-- can still be read.
CREATE FUNCTION "post_content_variants_file_references"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mention_mark_file_reference(m.media_id, 'post', OLD.post_id)
  FROM post_variant_media m
  WHERE m.variant_id = OLD.id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "post_content_variants_file_references"
BEFORE DELETE ON "post_content_variants"
FOR EACH ROW EXECUTE FUNCTION "post_content_variants_file_references"();
--> statement-breakpoint
-- `gif`: the library row's full mp4 and preview.
CREATE FUNCTION "gifs_file_references"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM mention_mark_file_reference(OLD.mp4_file_id, 'gif', OLD.id);
    PERFORM mention_mark_file_reference(OLD.preview_file_id, 'gif', OLD.id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM mention_mark_file_reference(NEW.mp4_file_id, 'gif', NEW.id);
    PERFORM mention_mark_file_reference(NEW.preview_file_id, 'gif', NEW.id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "gifs_file_references"
AFTER INSERT OR DELETE ON "gifs"
FOR EACH ROW EXECUTE FUNCTION "gifs_file_references"();
--> statement-breakpoint
CREATE TRIGGER "gifs_file_references_update"
AFTER UPDATE OF "mp4_file_id", "preview_file_id" ON "gifs"
FOR EACH ROW
WHEN ((OLD.mp4_file_id, OLD.preview_file_id) IS DISTINCT FROM (NEW.mp4_file_id, NEW.preview_file_id))
EXECUTE FUNCTION "gifs_file_references"();
--> statement-breakpoint
-- `profile_banner`: a local or federated account's banner, under the account.
CREATE FUNCTION "user_settings_file_references"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM mention_mark_file_reference(OLD.profile_header_image, 'profile_banner', OLD.oxy_user_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM mention_mark_file_reference(NEW.profile_header_image, 'profile_banner', NEW.oxy_user_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_settings_file_references"
AFTER INSERT OR DELETE ON "user_settings"
FOR EACH ROW EXECUTE FUNCTION "user_settings_file_references"();
--> statement-breakpoint
CREATE TRIGGER "user_settings_file_references_update"
AFTER UPDATE OF "profile_header_image", "oxy_user_id" ON "user_settings"
FOR EACH ROW
WHEN ((OLD.profile_header_image, OLD.oxy_user_id) IS DISTINCT FROM (NEW.profile_header_image, NEW.oxy_user_id))
EXECUTE FUNCTION "user_settings_file_references"();
--> statement-breakpoint
-- `video_poster`: the poster frame Oxy-hosted for a re-hosted federated video,
-- under the video's file id.
CREATE FUNCTION "federated_media_posters_file_references"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM mention_mark_file_reference(OLD.poster_file_id, 'video_poster', OLD.video_file_id);
  ELSE
    PERFORM mention_mark_file_reference(NEW.poster_file_id, 'video_poster', NEW.video_file_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "federated_media_posters_file_references"
AFTER INSERT OR DELETE ON "federated_media_posters"
FOR EACH ROW EXECUTE FUNCTION "federated_media_posters_file_references"();
--> statement-breakpoint
-- `job_application`: the resume attached to an application.
CREATE FUNCTION "mention_job_applications_file_references"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM mention_mark_file_reference(OLD.resume_file_id, 'job_application', OLD.id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM mention_mark_file_reference(NEW.resume_file_id, 'job_application', NEW.id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "mention_job_applications_file_references"
AFTER INSERT OR DELETE ON "mention_job_applications"
FOR EACH ROW EXECUTE FUNCTION "mention_job_applications_file_references"();
--> statement-breakpoint
CREATE TRIGGER "mention_job_applications_file_references_update"
AFTER UPDATE OF "resume_file_id" ON "mention_job_applications"
FOR EACH ROW
WHEN (OLD.resume_file_id IS DISTINCT FROM NEW.resume_file_id)
EXECUTE FUNCTION "mention_job_applications_file_references"();
--> statement-breakpoint
-- `moderation_report`: the evidence copies a report sent to CrowdSource.
CREATE FUNCTION "moderation_report_evidence_files_file_references"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM mention_mark_file_reference(OLD.evidence_file_id, 'moderation_report', OLD.report_id);
  ELSE
    PERFORM mention_mark_file_reference(NEW.evidence_file_id, 'moderation_report', NEW.report_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "moderation_report_evidence_files_file_references"
AFTER INSERT OR DELETE ON "moderation_report_evidence_files"
FOR EACH ROW EXECUTE FUNCTION "moderation_report_evidence_files_file_references"();
--> statement-breakpoint
-- Withholding follows the FILE, not the row: every new media row (an edit
-- re-inserts the whole set) and every media id rewrite takes the file's
-- current withholding from oxy_file_states.
CREATE FUNCTION "media_withheld_from_file_state"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.withheld := (SELECT s.withheld FROM oxy_file_states s WHERE s.file_id = NEW.media_id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "post_media_withheld_from_file_state"
BEFORE INSERT OR UPDATE OF "media_id" ON "post_media"
FOR EACH ROW EXECUTE FUNCTION "media_withheld_from_file_state"();
--> statement-breakpoint
CREATE TRIGGER "post_variant_media_withheld_from_file_state"
BEFORE INSERT OR UPDATE OF "media_id" ON "post_variant_media"
FOR EACH ROW EXECUTE FUNCTION "media_withheld_from_file_state"();
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.oxy_file_references_lock_timeout'), true);
