-- oxy:deploy-phase=pre
-- NodeInfo's local/external split (#1748) used `federation_actor_uri is null` as
-- "local". Measured on production (2026-11-02): of 306,973 public published rows
-- without an actor URI, 304,841 carry a `federation_activity_id` and a
-- `federation_url` — federated posts stored before the actor URI existed. The
-- boundary is now the row's own provenance: EXTERNAL = actor URI OR activity id,
-- LOCAL = neither.
--
-- Both partial indexes are small and keyed by `is_reply`, so one GROUP BY each
-- counts posts and comments index-only. The two indexes 0104 added carried the old
-- predicate and nothing else reads them, so they are replaced under new names (the
-- same name with a new predicate would be skipped by IF NOT EXISTS).
--
-- CREATE INDEX takes SHARE on `posts` for a scan of the table: reads continue,
-- writes wait. Optionally pre-build both CONCURRENTLY by hand with the same names
-- and definitions; a failed build leaves an INVALID index that IF NOT EXISTS skips,
-- so check `pg_index.indisvalid` first.
CREATE INDEX IF NOT EXISTS "posts_local_kind_idx" ON "posts" USING btree ("is_reply") WHERE "posts"."federation_actor_uri" is null and "posts"."federation_activity_id" is null and "posts"."visibility" = 'public' and "posts"."status" = 'published';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_external_kind_idx" ON "posts" USING btree ("is_reply") WHERE "posts"."federation_actor_uri" is not null or "posts"."federation_activity_id" is not null;--> statement-breakpoint
DROP INDEX IF EXISTS "posts_local_public_kind_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "posts_external_replies_idx";
