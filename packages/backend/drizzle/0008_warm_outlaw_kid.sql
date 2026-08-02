CREATE TABLE "blocked_domain_purge_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"run_id" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"trigger" text NOT NULL,
	"removed_posts" integer NOT NULL,
	"removed_actors" integer NOT NULL,
	"removed_boosts" integer NOT NULL,
	"removed_likes" integer NOT NULL,
	"removed_notifications" integer NOT NULL,
	"removed_media_cache_rows" integer NOT NULL,
	"removed_local_content_kept" integer NOT NULL,
	"removed_local_follows_removed" integer NOT NULL,
	"reason" text,
	"category" text,
	"corroborating_sources" text[],
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "blocked_domain_purge_runs_trigger_check" CHECK ("blocked_domain_purge_runs"."trigger" in ('policy_added', 'manual')),
	CONSTRAINT "blocked_domain_purge_runs_removed_check" CHECK ("blocked_domain_purge_runs"."removed_posts" >= 0
        and "blocked_domain_purge_runs"."removed_actors" >= 0
        and "blocked_domain_purge_runs"."removed_boosts" >= 0
        and "blocked_domain_purge_runs"."removed_likes" >= 0
        and "blocked_domain_purge_runs"."removed_notifications" >= 0
        and "blocked_domain_purge_runs"."removed_media_cache_rows" >= 0
        and "blocked_domain_purge_runs"."removed_local_content_kept" >= 0
        and "blocked_domain_purge_runs"."removed_local_follows_removed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "blocked_domain_purges" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"in_policy" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"run_id" text,
	"purged_at" timestamp with time zone,
	"held_reason" text,
	"failure_reason" text,
	"measured_posts" integer,
	"measured_actors" integer,
	"measured_boosts" integer,
	"measured_likes" integer,
	"measured_notifications" integer,
	"measured_media_cache_rows" integer,
	"measured_local_content_kept" integer,
	"measured_local_follows_removed" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "blocked_domain_purges_state_check" CHECK ("blocked_domain_purges"."state" in ('pending', 'in_progress', 'purged', 'held', 'failed')),
	CONSTRAINT "blocked_domain_purges_measured_check" CHECK (("blocked_domain_purges"."measured_posts" is null
          and "blocked_domain_purges"."measured_actors" is null
          and "blocked_domain_purges"."measured_boosts" is null
          and "blocked_domain_purges"."measured_likes" is null
          and "blocked_domain_purges"."measured_notifications" is null
          and "blocked_domain_purges"."measured_media_cache_rows" is null
          and "blocked_domain_purges"."measured_local_content_kept" is null
          and "blocked_domain_purges"."measured_local_follows_removed" is null)
        or ("blocked_domain_purges"."measured_posts" >= 0
          and "blocked_domain_purges"."measured_actors" >= 0
          and "blocked_domain_purges"."measured_boosts" >= 0
          and "blocked_domain_purges"."measured_likes" >= 0
          and "blocked_domain_purges"."measured_notifications" >= 0
          and "blocked_domain_purges"."measured_media_cache_rows" >= 0
          and "blocked_domain_purges"."measured_local_content_kept" >= 0
          and "blocked_domain_purges"."measured_local_follows_removed" >= 0))
);
--> statement-breakpoint
CREATE TABLE "blocklist_proposal_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"instance" text NOT NULL,
	"operator" text NOT NULL,
	"severity" text NOT NULL,
	"comment" text,
	"resolved_from_digest" boolean NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "blocklist_proposal_observations_severity_check" CHECK ("blocklist_proposal_observations"."severity" in ('suspend', 'silence', 'noop')),
	CONSTRAINT "blocklist_proposal_observations_position_check" CHECK ("blocklist_proposal_observations"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "blocklist_proposal_run_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"run_row_id" text NOT NULL,
	"instance" text NOT NULL,
	"operator" text NOT NULL,
	"outcome" text NOT NULL,
	"entries" integer NOT NULL,
	"detail" text,
	"position" integer NOT NULL,
	CONSTRAINT "blocklist_proposal_run_sources_outcome_check" CHECK ("blocklist_proposal_run_sources"."outcome" in ('published', 'unavailable', 'unparseable', 'empty')),
	CONSTRAINT "blocklist_proposal_run_sources_counts_check" CHECK ("blocklist_proposal_run_sources"."entries" >= 0 and "blocklist_proposal_run_sources"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "blocklist_proposal_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"min_operators" integer NOT NULL,
	"counts_domains_observed" integer NOT NULL,
	"counts_cleared_operator_threshold" integer NOT NULL,
	"counts_opened" integer NOT NULL,
	"counts_pending" integer NOT NULL,
	"counts_suppressed_declined" integer NOT NULL,
	"counts_suppressed_blocked" integer NOT NULL,
	"counts_lapsed" integer NOT NULL,
	"counts_adopted" integer NOT NULL,
	"ok" boolean NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "blocklist_proposal_runs_trigger_check" CHECK ("blocklist_proposal_runs"."trigger" in ('scheduled', 'manual')),
	CONSTRAINT "blocklist_proposal_runs_counts_check" CHECK ("blocklist_proposal_runs"."min_operators" >= 0
        and "blocklist_proposal_runs"."counts_domains_observed" >= 0
        and "blocklist_proposal_runs"."counts_cleared_operator_threshold" >= 0
        and "blocklist_proposal_runs"."counts_opened" >= 0
        and "blocklist_proposal_runs"."counts_pending" >= 0
        and "blocklist_proposal_runs"."counts_suppressed_declined" >= 0
        and "blocklist_proposal_runs"."counts_suppressed_blocked" >= 0
        and "blocklist_proposal_runs"."counts_lapsed" >= 0
        and "blocklist_proposal_runs"."counts_adopted" >= 0)
);
--> statement-breakpoint
CREATE TABLE "blocklist_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_proposed_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"operator_count" integer NOT NULL,
	"corroborating_sources" text[] NOT NULL,
	"footprint_actors" integer NOT NULL,
	"footprint_posts" integer NOT NULL,
	"footprint_local_users_following" integer NOT NULL,
	"footprint_remote_actors_followed" integer NOT NULL,
	"footprint_local_users_followed" integer NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "blocklist_proposals_status_check" CHECK ("blocklist_proposals"."status" in ('open', 'declined', 'adopted', 'lapsed')),
	CONSTRAINT "blocklist_proposals_counts_check" CHECK ("blocklist_proposals"."operator_count" >= 0
        and "blocklist_proposals"."footprint_actors" >= 0
        and "blocklist_proposals"."footprint_posts" >= 0
        and "blocklist_proposals"."footprint_local_users_following" >= 0
        and "blocklist_proposals"."footprint_remote_actors_followed" >= 0
        and "blocklist_proposals"."footprint_local_users_followed" >= 0)
);
--> statement-breakpoint
ALTER TABLE "blocklist_proposal_observations" ADD CONSTRAINT "blocklist_proposal_observations_proposal_id_blocklist_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."blocklist_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocklist_proposal_run_sources" ADD CONSTRAINT "blocklist_proposal_run_sources_run_row_id_blocklist_proposal_runs_id_fk" FOREIGN KEY ("run_row_id") REFERENCES "public"."blocklist_proposal_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_domain_purge_runs_domain_run_id_key" ON "blocked_domain_purge_runs" USING btree ("domain","run_id");--> statement-breakpoint
CREATE INDEX "blocked_domain_purge_runs_domain_chrono_idx" ON "blocked_domain_purge_runs" USING btree ("domain","run_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_domain_purges_domain_key" ON "blocked_domain_purges" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "blocked_domain_purges_state_claimed_idx" ON "blocked_domain_purges" USING btree ("state","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "blocklist_proposal_observations_proposal_id_instance_key" ON "blocklist_proposal_observations" USING btree ("proposal_id","instance");--> statement-breakpoint
CREATE INDEX "blocklist_proposal_observations_proposal_idx" ON "blocklist_proposal_observations" USING btree ("proposal_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "blocklist_proposal_run_sources_run_row_id_instance_key" ON "blocklist_proposal_run_sources" USING btree ("run_row_id","instance");--> statement-breakpoint
CREATE UNIQUE INDEX "blocklist_proposal_runs_run_id_key" ON "blocklist_proposal_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "blocklist_proposal_runs_started_at_idx" ON "blocklist_proposal_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "blocklist_proposals_domain_key" ON "blocklist_proposals" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "blocklist_proposals_status_chrono_idx" ON "blocklist_proposals" USING btree ("status","first_proposed_at");