-- Remember where a remote account moved.
--
-- `moved_to` is the actor URI a remote account announced it moved to, written
-- only from a verified inbound `Move` whose target lists the old actor in its
-- `alsoKnownAs` (`connectors/activitypub/move.service.ts`, `recordRemoteMove`).
-- The profile page reads it to tell a reader the account has moved and where.
-- Nullable, no default, no backfill: every existing row is an account with no
-- recorded move.
ALTER TABLE "federated_actors" ADD COLUMN "moved_to" text;
