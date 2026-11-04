-- oxy:deploy-phase=pre
-- A federated account's own visibility opt-outs, read by the SEO policy and the
-- signed-out hydration gate: ActivityPub `indexable` (NULL = the origin made no
-- statement, which for an ActivityPub actor means "not indexable") and Bluesky's
-- `!no-unauthenticated` self-label. A nullable column and a constant-default
-- NOT NULL column are both catalogue-only changes on Postgres 11+ (no rewrite),
-- so the ACCESS EXCLUSIVE lock on hot `federated_actors` lasts an instant. No
-- backfill: existing rows read as "no statement" and "visible signed out" until
-- their next refresh writes what the origin says.
ALTER TABLE "federated_actors" ADD COLUMN IF NOT EXISTS "indexable" boolean;--> statement-breakpoint
ALTER TABLE "federated_actors" ADD COLUMN IF NOT EXISTS "requires_sign_in" boolean DEFAULT false NOT NULL;
