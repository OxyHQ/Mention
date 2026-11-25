-- oxy:deploy-phase=pre
-- The CHECKs of the two blocklist tables, restated over the new repost columns. NOT VALID here
-- (no scan); 0131 validates them.
ALTER TABLE "blocked_domain_purge_runs" ADD CONSTRAINT "blocked_domain_purge_runs_removed_reposts_check" CHECK ("blocked_domain_purge_runs"."removed_posts" >= 0
        and "blocked_domain_purge_runs"."removed_actors" >= 0
        and "blocked_domain_purge_runs"."removed_reposts" >= 0
        and "blocked_domain_purge_runs"."removed_likes" >= 0
        and "blocked_domain_purge_runs"."removed_notifications" >= 0
        and "blocked_domain_purge_runs"."removed_media_cache_rows" >= 0
        and "blocked_domain_purge_runs"."removed_local_content_kept" >= 0
        and "blocked_domain_purge_runs"."removed_local_follows_removed" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "blocked_domain_purges" ADD CONSTRAINT "blocked_domain_purges_measured_reposts_check" CHECK (("blocked_domain_purges"."measured_posts" is null
          and "blocked_domain_purges"."measured_actors" is null
          and "blocked_domain_purges"."measured_reposts" is null
          and "blocked_domain_purges"."measured_likes" is null
          and "blocked_domain_purges"."measured_notifications" is null
          and "blocked_domain_purges"."measured_media_cache_rows" is null
          and "blocked_domain_purges"."measured_local_content_kept" is null
          and "blocked_domain_purges"."measured_local_follows_removed" is null)
        or ("blocked_domain_purges"."measured_posts" >= 0
          and "blocked_domain_purges"."measured_actors" >= 0
          and "blocked_domain_purges"."measured_reposts" >= 0
          and "blocked_domain_purges"."measured_likes" >= 0
          and "blocked_domain_purges"."measured_notifications" >= 0
          and "blocked_domain_purges"."measured_media_cache_rows" >= 0
          and "blocked_domain_purges"."measured_local_content_kept" >= 0
          and "blocked_domain_purges"."measured_local_follows_removed" >= 0)) NOT VALID;
