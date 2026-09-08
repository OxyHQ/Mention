-- Stable sitemap partitions must remain cheap as the post archive grows.
-- Without these expression indexes, opening any one child sitemap requires
-- hashing every eligible post before PostgreSQL can discard the other 63
-- buckets. With them, the planner can seek the requested bucket and walk its
-- ids in sitemap order. The partial predicate excludes rows that can never be
-- indexed while leaving discovery-safety and profile-privacy checks dynamic.
--
-- This is not an online migration: drizzle's migrator wraps the file in a
-- transaction, so CREATE INDEX CONCURRENTLY is unavailable. Reads continue,
-- but writes to posts wait while each index is built. At roughly one million
-- rows these are bounded btree builds; if a substantially larger deployment
-- applies this migration later, operators should prebuild the same indexes
-- concurrently before running the migrator.

CREATE INDEX "posts_seo_post_bucket_idx" ON "posts" USING btree ((mod(('x' || substr(md5("id"), 1, 8))::bit(32)::bigint, 64)::int),"id") WHERE "posts"."visibility" = 'public' and "posts"."status" = 'published' and "posts"."oxy_user_id" is not null;--> statement-breakpoint
CREATE INDEX "posts_seo_profile_bucket_idx" ON "posts" USING btree ((mod(('x' || substr(md5("oxy_user_id"), 1, 8))::bit(32)::bigint, 64)::int),"oxy_user_id","updated_at") WHERE "posts"."visibility" = 'public' and "posts"."status" = 'published' and "posts"."oxy_user_id" is not null;
