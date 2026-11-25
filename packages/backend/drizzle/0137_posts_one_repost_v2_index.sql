-- oxy:deploy-phase=pre
-- The one-repost-per-account rule over both names of the stored type. posts is hot, so alone in its
-- file; built CONCURRENTLY by hand in production before this ran, so IF NOT EXISTS makes it a no-op there.
CREATE UNIQUE INDEX IF NOT EXISTS "posts_one_repost_per_account_v2_key" ON "posts" USING btree ("oxy_user_id","repost_of") WHERE "posts"."type" in ('boost', 'repost') and "posts"."repost_of" is not null and "posts"."federation_activity_id" is null;

