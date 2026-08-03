-- Retire the Mention-local channel, and re-key `lanes` onto a single owner.
--
-- The Postgres half of what `src/migrations/0026-channel-accounts.ts` does to
-- Mongo, and the same four groups of operations. A channel is an Oxy ACCOUNT
-- now (`kind: 'channel'`), so a channel post is AUTHORED BY it —
-- `posts.oxy_user_id` and `post_authorships` hold the channel, and the human who
-- wrote it is recorded outside authorship in `posts.written_by_oxy_user_id`
-- (added by `0013`). Everything dropped here existed only to express the
-- previous shape, in which a channel was a Mention row and the post was authored
-- by a person and published TO it.
--
-- WHAT THIS COSTS, MEASURED RATHER THAN ASSUMED. Against production Mongo the
-- `channels`, `channelmembers` and `channelfollows` collections do not exist,
-- the three tables here copied ZERO rows, and 0 of 596,309 posts carry a
-- `channelId` (0 distinct values). `lanes` holds exactly one row and it is a
-- person's. So every DROP below is a drop of something empty, and the `lanes`
-- re-key cannot collide.
--
-- ## Statement ORDER is hand-written, and two orderings are load-bearing
--
-- drizzle-kit generated this file and its order was WRONG in a way that fails on
-- a real database rather than silently: it emitted `DROP TABLE "channels"
-- CASCADE` BEFORE `ALTER TABLE "posts" DROP CONSTRAINT
-- "posts_channel_id_channels_id_fk"`, and the CASCADE removes that constraint,
-- so the explicit drop then raised `constraint ... does not exist` and the whole
-- migration aborted. Verified against postgis/postgis:17-3.5 — the generated
-- file fails, this one applies. Reordering does not desynchronise the snapshot
-- (`meta/0017_snapshot.json` records the END STATE, which is unchanged), unlike
-- the hand-written `NOT VALID` pair migration `0012` explains it deliberately
-- did not write.
--
--  1. The FK on `posts.channel_id` goes FIRST, so no `CASCADE` can get to it.
--  2. The `lanes` UNIQUE is dropped and re-added under the SAME NAME, which is
--     the one place this file cannot copy `0026`'s "create the new index before
--     dropping the old" ordering: Mongo derived two DIFFERENT index names from
--     the two key shapes (`ownerType_1_ownerId_1_nameLower_1` and
--     `ownerId_1_nameLower_1`) and could hold both at once, while here the
--     constraint is named `lanes_owner_name_lower_key` on either key shape, so
--     adding first raises "constraint already exists". What closes the window
--     instead is that drizzle-orm's migrator runs each migration file in ONE
--     transaction: the `ALTER TABLE`s hold ACCESS EXCLUSIVE throughout, so no
--     concurrent writer can observe the table without its unique constraint.
--     That is a property of the migrator, so if migrations ever stop being
--     transactional this statement pair needs re-examining — and the reason it is
--     acceptable to rely on it here is the measurement above: one row.
--
-- `owner_type` is dropped rather than kept and ignored: a channel is an Oxy
-- account, so the discriminator had exactly one reachable value, and a
-- single-valued discriminator is a branch every reader has to prove is dead. The
-- uniqueness key moves with it — under `(owner_type, owner_id, name_lower)` one
-- publisher could hold the same lane name twice, once per owner type.
ALTER TABLE "posts" DROP CONSTRAINT "posts_channel_id_channels_id_fk";--> statement-breakpoint
DROP INDEX "post_channel_chrono_v1";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "channel_id";--> statement-breakpoint
ALTER TABLE "channel_follows" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channels" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "channel_follows" CASCADE;--> statement-breakpoint
DROP TABLE "channel_members" CASCADE;--> statement-breakpoint
DROP TABLE "channels" CASCADE;--> statement-breakpoint
ALTER TABLE "lanes" DROP CONSTRAINT "lanes_owner_name_lower_key";--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_owner_name_lower_key" UNIQUE("owner_id","name_lower");--> statement-breakpoint
ALTER TABLE "lanes" DROP CONSTRAINT "lanes_owner_type_check";--> statement-breakpoint
DROP INDEX "lanes_owner_idx";--> statement-breakpoint
CREATE INDEX "lanes_owner_idx" ON "lanes" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "lanes" DROP COLUMN "owner_type";
