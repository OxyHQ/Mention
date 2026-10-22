-- oxy:deploy-phase=pre
-- `file.lost` joins the file event types Oxy sends (core 6.12.0, ADR 0043 D13):
-- a file whose bytes are gone for good. Mention withholds it as deleted.
--
-- Pre-deploy: the list only widens, so the running release keeps writing rows
-- the new CHECK accepts, and the new release can record `file.lost` from its
-- first event. Re-adding the CHECK scans `oxy_file_events` under its lock; the
-- table is the file-event audit (one row per delivered event), small enough
-- that the scan stays inside the migrator's lock_timeout.
ALTER TABLE "oxy_file_events" DROP CONSTRAINT "oxy_file_events_type_check";--> statement-breakpoint
ALTER TABLE "oxy_file_events" ADD CONSTRAINT "oxy_file_events_type_check" CHECK ("oxy_file_events"."type" in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked', 'file.lost'));
