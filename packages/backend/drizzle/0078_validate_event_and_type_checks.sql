-- oxy:deploy-phase=pre
-- Validate the four CHECKs `0075_ecosystem_references_and_events` added
-- NOT VALID. Nothing else: no column, no rewrite, no DML.
--
-- `ALTER TABLE … VALIDATE CONSTRAINT` takes SHARE UPDATE EXCLUSIVE, which does
-- not conflict with SELECT, INSERT, UPDATE or DELETE — readers and writers keep
-- going while each table is scanned. It does conflict with other DDL and with
-- autovacuum on the same table, which is why it lives in its own migration and
-- runs under the migrator's 3 s `lock_timeout` (a lost lock race rolls back and
-- retries; see `@oxy.so/db/migrate`'s `locks.ts`).
--
-- Every existing row already satisfies every one of them: new and updated rows
-- have been checked since 0075, the event columns are NULL / 0 on every older
-- post, and each widened type list is a superset of the one it replaced.
-- Measured against production on 2026-10-17 before this was written: zero
-- violating rows in `posts` (~2.0 M rows, 1.6 GB heap, full scan ~14 s),
-- `notifications` and `post_attachments` (~0.5 M rows).
ALTER TABLE "posts" VALIDATE CONSTRAINT "posts_event_capacity_check";--> statement-breakpoint
ALTER TABLE "posts" VALIDATE CONSTRAINT "posts_event_revision_check";--> statement-breakpoint
ALTER TABLE "notifications" VALIDATE CONSTRAINT "notifications_type_check";--> statement-breakpoint
ALTER TABLE "post_attachments" VALIDATE CONSTRAINT "post_attachments_type_check";
