-- oxy:deploy-phase=pre
-- Indexes of the boost -> repost switch (docs/repost-rename.md), on the hot posts table, alone in
-- this file. They were built CONCURRENTLY by hand in production before this ran, so here
-- IF NOT EXISTS makes it a no-op there and builds them on a fresh database. The old indexes
-- (on boost_of and the boost counters) stay until the contract step; the `_v2` names are
-- renamed back to the original names when the old ones are dropped.
CREATE INDEX IF NOT EXISTS "posts_public_originals_recent_v2_idx" ON "posts" USING btree ("created_at") WHERE "posts"."visibility" = 'public' and "posts"."status" = 'published' and "posts"."repost_of" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_repost_of_idx" ON "posts" USING btree ("repost_of","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "posts_one_repost_per_account_key" ON "posts" USING btree ("oxy_user_id","repost_of") WHERE "posts"."type" = 'boost' and "posts"."repost_of" is not null and "posts"."federation_activity_id" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_engagement_rank_v2_idx" ON "posts" USING btree (((
    "stats_likes_count" * 1::double precision
    + greatest(0, "stats_reposts_count" - "stats_federated_reposts_count") * 2.5::double precision
    + "stats_federated_reposts_count" * 0.5::double precision
    + "stats_comments_count" * 2::double precision
  )::double precision) desc,"created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "posts"."visibility" = 'public' and "posts"."status" = 'published';
