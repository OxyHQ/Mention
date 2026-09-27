-- Indexes for the federated-media deletion drain's reference check
-- (db/federation/mediaDeletionRepository.ts): before asking Oxy to delete a
-- re-hosted file, the drain looks the id up in `post_media.media_id` (already
-- indexed), `post_variant_media.media_id` and
-- `user_settings.profile_header_image`. Without these two indexes each check was
-- a sequential scan of those tables.
--
-- LOCK PROFILE — measured with `pg_locks` (src/__tests__/db/
-- federatedMediaReferenceIndexLocks.test.ts), not assumed: CREATE INDEX takes
-- SHARE on `post_variant_media` and `user_settings`. Reads continue; writes to
-- those two tables wait for the build (the migrator runs every pending file in
-- ONE transaction, so CONCURRENTLY is unavailable here). No other table is
-- locked. Lock waits are bounded at 5 s and statements at 60 s, so the
-- migration fails instead of queueing writers behind a long build; the
-- connection's previous timeouts are restored for any later migration.
--
-- On a large database, build both indexes CONCURRENTLY by hand before the
-- deploy (same names and definitions as below); `IF NOT EXISTS` then makes this
-- file a no-op for them.
SELECT set_config('mention.fm_reference_lock_timeout', current_setting('lock_timeout'), true),
       set_config('mention.fm_reference_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "post_variant_media_media_id_idx" ON "post_variant_media" USING btree ("media_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_settings_profile_header_image_idx" ON "user_settings" USING btree ("profile_header_image") WHERE "user_settings"."profile_header_image" is not null;
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('mention.fm_reference_lock_timeout'), true),
       set_config('statement_timeout', current_setting('mention.fm_reference_statement_timeout'), true);
