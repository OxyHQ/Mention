-- oxy:deploy-phase=pre
-- Only widen the attachment vocabulary. Validate separately to avoid holding
-- the hot-table ACCESS EXCLUSIVE lock during its existing-row scan.
CREATE TABLE "account_storefronts" (
	"oxy_account_id" text PRIMARY KEY NOT NULL,
	"mercaria_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_attachments" DROP CONSTRAINT "post_attachments_type_check";--> statement-breakpoint
ALTER TABLE "post_attachments" ADD CONSTRAINT "post_attachments_type_check" CHECK ("post_attachments"."type" in ('media', 'poll', 'article', 'event', 'location', 'sources', 'room', 'podcast', 'homiioCase', 'job', 'commerce')) NOT VALID;