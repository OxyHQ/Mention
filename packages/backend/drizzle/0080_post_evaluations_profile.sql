-- oxy:deploy-phase=pre
-- The continuous Jev shadow lane (docs/jev-shadow-evaluation.md). A decisions
-- request no longer names a model: Oxy's decisions profile chooses, so the
-- model and routing policy are facts of the ANSWER, known only on completion.
--
-- - `model`, `policy_ref` and `policy_version` become NULL until completion;
--   `resolved_model` records the model that answered and is required, with
--   the policy, on every completed row.
-- - A revision is evaluated once per evaluation version: the unique key drops
--   model and policy. The old key was these columns plus model and policy, so
--   only two rows of one revision and version differing in model or policy
--   could collide; production holds three rows from the 2026-10 one-post runs.
--   If two did collide, the constraint fails and the whole migration rolls back.
-- - The one completed row from the 2026-10 one-post runs gets
--   `resolved_model = model`: that consumer refused any answer whose model
--   differed from the one it pinned.
-- - `post_evaluations_created_idx` serves the lane's daily claim count.
--
-- Old tasks stay correct during the rollout: they insert `model` and policy as
-- before, and their lane is inert (its approval expired 2026-10-05), so they
-- never complete a row without `resolved_model`. A small table; every
-- statement runs under the migrator's lock_timeout.
ALTER TABLE "post_evaluations" DROP CONSTRAINT "post_evaluations_revision_release_key";--> statement-breakpoint
ALTER TABLE "post_evaluations" DROP CONSTRAINT "post_evaluations_result_check";--> statement-breakpoint
ALTER TABLE "post_evaluations" ALTER COLUMN "model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "post_evaluations" ALTER COLUMN "policy_ref" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "post_evaluations" ALTER COLUMN "policy_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "post_evaluations" ADD COLUMN "resolved_model" text;--> statement-breakpoint
UPDATE "post_evaluations" SET "resolved_model" = "model" WHERE "state" = 'completed';--> statement-breakpoint
CREATE INDEX "post_evaluations_created_idx" ON "post_evaluations" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "post_evaluations" ADD CONSTRAINT "post_evaluations_revision_version_key" UNIQUE("post_id","fingerprint","evaluation_version");--> statement-breakpoint
ALTER TABLE "post_evaluations" ADD CONSTRAINT "post_evaluations_result_check" CHECK ((
    "post_evaluations"."state" = 'completed' and "post_evaluations"."spam" is not null and "post_evaluations"."repetition" is not null
    and "post_evaluations"."feed_value" is not null and "post_evaluations"."languages" is not null
    and "post_evaluations"."sdk_receipt" is not null and "post_evaluations"."language_evidence" is not null
    and "post_evaluations"."resolved_model" is not null and "post_evaluations"."policy_ref" is not null
    and "post_evaluations"."policy_version" is not null
    and "post_evaluations"."abstention" is null and "post_evaluations"."finished_at" is not null
  ) or (
    "post_evaluations"."state" <> 'completed' and "post_evaluations"."spam" is null and "post_evaluations"."repetition" is null
    and "post_evaluations"."feed_value" is null and "post_evaluations"."languages" is null
    and "post_evaluations"."sdk_receipt" is null and "post_evaluations"."language_evidence" is null
    and (("post_evaluations"."state" = 'abstained' and "post_evaluations"."abstention" is not null)
      or ("post_evaluations"."state" <> 'abstained' and "post_evaluations"."abstention" is null))
  ));