-- A remote actor's followers/following/posts counts become NULLABLE: NULL is
-- UNKNOWN, and 0 is a real zero.
--
-- WHY: `@oxy.so/federation` < 2.0 stored `0` whenever it could not read a remote
-- collection (hidden 401/403, 404, timeout, no `totalItems`), and the NOT NULL
-- DEFAULT 0 columns could not say "unknown" either — so a remote profile with
-- thousands of followers rendered "0 followers" (OxyHQ/Mention#1126 item 10).
-- 2.0 hands the store `null` for a definitive unknown and OMITS the count on a
-- failed refresh, which the repository turns into "keep the stored value".
--
-- Dropping NOT NULL / DEFAULT is safe during a rolling deploy: the previous
-- release always writes an explicit number.
ALTER TABLE "federated_actors" ALTER COLUMN "followers_count" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "federated_actors" ALTER COLUMN "followers_count" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "federated_actors" ALTER COLUMN "following_count" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "federated_actors" ALTER COLUMN "following_count" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "federated_actors" ALTER COLUMN "posts_count" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "federated_actors" ALTER COLUMN "posts_count" DROP NOT NULL;--> statement-breakpoint
-- Repair: an ActivityPub 0 written before 2.0 is not evidence of a real zero —
-- it is also what every failed collection read produced. Forget it; the next
-- refresh re-reads the collection and stores a genuine 0 as 0. posts_count is
-- left alone: the outbox sync reads it, and a zero there only skips work.
UPDATE "federated_actors" SET "followers_count" = NULL WHERE "protocol" = 'activitypub' AND "followers_count" = 0;--> statement-breakpoint
UPDATE "federated_actors" SET "following_count" = NULL WHERE "protocol" = 'activitypub' AND "following_count" = 0;
