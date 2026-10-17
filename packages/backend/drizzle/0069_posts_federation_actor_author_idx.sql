-- oxy:deploy-phase=post
-- The source-actor index carries the post's author (`oxy_user_id`) in its key.
--
-- `reconcileActorIdentityProjection` runs on every actor refresh. It asks for
-- the source's posts that do not carry the current Oxy id yet — none, for a
-- source already projected — and for the other ids those posts carry. With the
-- index on `federation_actor_uri` alone, both reads fetched every one of the
-- source's posts from the heap to look at `oxy_user_id`, and the count also
-- probed each post's owner authorship: a 2.6k-post actor cost ~2.4k `posts` heap
-- pages plus ~2.6k `post_authorships` probes, 2.7 s cold (EXPLAIN ANALYZE,
-- production, 2026-10-15). Slow-query log, 2026-10-14: 230 entries for the count
-- (avg 512 ms, max 5 s) and 137 for the `select distinct` (avg 528 ms, max 6 s).
-- With `oxy_user_id` in the key both are an index-only walk of the source's
-- entries; only entries on pages not yet marked all-visible visit the heap.
--
-- Built under a new name BEFORE the old index is dropped. DROP INDEX takes
-- ACCESS EXCLUSIVE on `posts` until the migration commits, so dropping first
-- would block every read of `posts` for the length of the build. CREATE INDEX
-- takes SHARE: reads continue, writes wait. Refuse after 5 s waiting for a lock
-- or 60 s running, like 0039 which built the index this replaces.
SELECT set_config('mention.source_author_idx_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.source_author_idx_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_federation_actor_author_idx" ON "posts" USING btree ("federation_actor_uri","oxy_user_id") WHERE "posts"."federation_actor_uri" is not null;
--> statement-breakpoint
-- Every query the old index served leads with `federation_actor_uri`, which
-- the new index also leads with.
DROP INDEX IF EXISTS "posts_federation_actor_uri_idx";
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.source_author_idx_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.source_author_idx_statement_timeout'), true);
