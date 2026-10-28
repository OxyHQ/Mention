-- oxy:deploy-phase=pre
CREATE TABLE "membership_review_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"operator_oxy_user_id" text,
	"action" text NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "membership_review_audits_action_check" CHECK ("membership_review_audits"."action" in ('inspect', 'download_media', 'remove_content', 'suspend_community', 'dismiss_report'))
);
--> statement-breakpoint
ALTER TABLE "membership_review_audits" ADD CONSTRAINT "membership_review_audits_report_id_membership_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."membership_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_review_audits_report_idx" ON "membership_review_audits" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE INDEX "membership_review_audits_operator_idx" ON "membership_review_audits" USING btree ("operator_oxy_user_id");