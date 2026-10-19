-- oxy:deploy-phase=post
-- Drop two `post_evaluations` columns nothing writes or reads since the
-- continuous Jev shadow lane (0080): `model`, the model a request pinned (a
-- decisions request names none; `resolved_model` records the one that
-- answered), and `receipt_authority`, the approval lineage of the 2026-10
-- one-post runs. Post phase: tasks of the previous release still name both
-- columns in their selects until they are replaced. A small table; each
-- statement runs under the migrator's lock_timeout.
ALTER TABLE "post_evaluations" DROP COLUMN "model";--> statement-breakpoint
ALTER TABLE "post_evaluations" DROP COLUMN "receipt_authority";
