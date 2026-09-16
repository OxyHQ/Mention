CREATE TABLE "mention_job_application_answers" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "mention_job_application_answers_application_id_position_key" UNIQUE("application_id","position"),
	CONSTRAINT "mention_job_application_answers_position_check" CHECK ("mention_job_application_answers"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mention_job_application_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"author_oxy_user_id" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mention_job_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"applicant_oxy_user_id" text NOT NULL,
	"display_name" text,
	"contact_method" text,
	"resume_file_id" text,
	"cover_note" text,
	"portfolio_links" text[],
	"status" text DEFAULT 'new' NOT NULL,
	"assigned_to_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "mention_job_applications_job_id_applicant_key" UNIQUE("job_id","applicant_oxy_user_id"),
	CONSTRAINT "mention_job_applications_status_check" CHECK ("mention_job_applications"."status" in ('new','reviewing','interview','rejected','hired','withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "mention_job_daily_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"apply_starts" integer DEFAULT 0 NOT NULL,
	"external_apply_clicks" integer DEFAULT 0 NOT NULL,
	"completed_applications" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "mention_job_daily_metrics_job_id_day_key" UNIQUE("job_id","day"),
	CONSTRAINT "mention_job_daily_metrics_views_check" CHECK ("mention_job_daily_metrics"."views" >= 0),
	CONSTRAINT "mention_job_daily_metrics_apply_starts_check" CHECK ("mention_job_daily_metrics"."apply_starts" >= 0),
	CONSTRAINT "mention_job_daily_metrics_external_clicks_check" CHECK ("mention_job_daily_metrics"."external_apply_clicks" >= 0),
	CONSTRAINT "mention_job_daily_metrics_completed_applications_check" CHECK ("mention_job_daily_metrics"."completed_applications" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mention_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"employer_oxy_user_id" text NOT NULL,
	"author_oxy_user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"location_raw" text,
	"location_country_code" text,
	"location_region" text,
	"location_city" text,
	"workplace_type" text,
	"employment_type" text,
	"salary_min" integer,
	"salary_max" integer,
	"salary_currency" text,
	"salary_interval" text,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"application_mode" text DEFAULT 'external' NOT NULL,
	"external_apply_url" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"slug" text NOT NULL,
	"application_count" integer DEFAULT 0 NOT NULL,
	"clarity_sync_status" text DEFAULT 'pending' NOT NULL,
	"clarity_document_id" text,
	"clarity_synced_at" timestamp with time zone,
	"clarity_sync_error" text,
	"clarity_sync_attempts" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "mention_jobs_application_count_check" CHECK ("mention_jobs"."application_count" >= 0),
	CONSTRAINT "mention_jobs_clarity_sync_attempts_check" CHECK ("mention_jobs"."clarity_sync_attempts" >= 0),
	CONSTRAINT "mention_jobs_status_check" CHECK ("mention_jobs"."status" in ('draft', 'published', 'paused', 'closed', 'expired')),
	CONSTRAINT "mention_jobs_clarity_sync_status_check" CHECK ("mention_jobs"."clarity_sync_status" in ('pending', 'synced', 'failed')),
	CONSTRAINT "mention_jobs_salary_complete_check" CHECK (("mention_jobs"."salary_min" is null and "mention_jobs"."salary_max" is null and "mention_jobs"."salary_currency" is null and "mention_jobs"."salary_interval" is null)
        or ("mention_jobs"."salary_currency" is not null and "mention_jobs"."salary_interval" is not null)),
	CONSTRAINT "mention_jobs_salary_range_check" CHECK ("mention_jobs"."salary_min" is null or "mention_jobs"."salary_max" is null or "mention_jobs"."salary_min" <= "mention_jobs"."salary_max"),
	CONSTRAINT "mention_jobs_application_mode_check" CHECK (("mention_jobs"."application_mode" = 'external' and "mention_jobs"."external_apply_url" is not null)
        or ("mention_jobs"."application_mode" = 'mention' and "mention_jobs"."external_apply_url" is null))
);
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_reported_type_check";--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_categories_check";--> statement-breakpoint
ALTER TABLE "post_attachments" DROP CONSTRAINT "post_attachments_type_check";--> statement-breakpoint
ALTER TABLE "mention_job_application_answers" ADD CONSTRAINT "mention_job_application_answers_application_id_mention_job_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."mention_job_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_job_application_notes" ADD CONSTRAINT "mention_job_application_notes_application_id_mention_job_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."mention_job_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_job_applications" ADD CONSTRAINT "mention_job_applications_job_id_mention_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."mention_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_job_daily_metrics" ADD CONSTRAINT "mention_job_daily_metrics_job_id_mention_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."mention_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mention_job_application_answers_application_idx" ON "mention_job_application_answers" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "mention_job_application_notes_application_chrono_idx" ON "mention_job_application_notes" USING btree ("application_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mention_job_applications_job_chrono_idx" ON "mention_job_applications" USING btree ("job_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mention_job_applications_applicant_idx" ON "mention_job_applications" USING btree ("applicant_oxy_user_id");--> statement-breakpoint
CREATE INDEX "mention_job_daily_metrics_job_chrono_idx" ON "mention_job_daily_metrics" USING btree ("job_id","day" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "mention_jobs_slug_key" ON "mention_jobs" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "mention_jobs_employer_chrono_idx" ON "mention_jobs" USING btree ("employer_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mention_jobs_status_idx" ON "mention_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mention_jobs_closes_at_idx" ON "mention_jobs" USING btree ("closes_at") WHERE "mention_jobs"."status" = 'published';--> statement-breakpoint
CREATE INDEX "mention_jobs_clarity_sync_status_idx" ON "mention_jobs" USING btree ("clarity_sync_status") WHERE "mention_jobs"."clarity_sync_status" = 'failed';--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_type_check" CHECK ("reports"."reported_type" in ('post', 'user', 'comment', 'message', 'room', 'job'));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_categories_check" CHECK (array_length("reports"."categories", 1) >= 1
        and "reports"."categories" <@ array['spam', 'hate_speech', 'harassment', 'misinformation', 'explicit_content', 'scam', 'discriminatory', 'impersonation', 'already_filled', 'duplicate', 'other']::text[]);--> statement-breakpoint
ALTER TABLE "post_attachments" ADD CONSTRAINT "post_attachments_type_check" CHECK ("post_attachments"."type" in ('media', 'poll', 'article', 'event', 'location', 'sources', 'room', 'podcast', 'job'));