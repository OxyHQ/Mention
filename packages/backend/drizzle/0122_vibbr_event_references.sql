-- oxy:deploy-phase=pre
-- A Mention post references a Vibbr event by its id only (`evt_<24 hex>`), so the
-- attachment vocabulary gains `vibbrEvent` and posts gain the id column. Additive:
-- the previous release writes neither. The CHECK is widened NOT VALID and validated
-- by the next migration, to avoid holding the hot-table ACCESS EXCLUSIVE lock during
-- its existing-row scan (0094/0095).
ALTER TABLE "post_attachments" DROP CONSTRAINT "post_attachments_type_check";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "content_vibbr_event_id" text;--> statement-breakpoint
ALTER TABLE "post_attachments" ADD CONSTRAINT "post_attachments_type_check" CHECK ("post_attachments"."type" in ('media', 'poll', 'article', 'event', 'location', 'sources', 'room', 'podcast', 'homiioCase', 'job', 'commerce', 'vibbrEvent')) NOT VALID;
