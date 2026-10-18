-- oxy:deploy-phase=pre
-- The Jev shadow lane's terminal `rejected` state (docs/jev-shadow-evaluation.md):
-- Kaana refused that request itself before it ran, so it is kept and never
-- resent instead of being released and reclaimed every cycle. Widens the
-- state list only; every existing row satisfies it. A small table, under the
-- migrator's lock_timeout.
ALTER TABLE "post_evaluations" DROP CONSTRAINT "post_evaluations_state_check";--> statement-breakpoint
ALTER TABLE "post_evaluations" ADD CONSTRAINT "post_evaluations_state_check" CHECK ("post_evaluations"."state" in ('claimed', 'completed', 'abstained', 'cancelled', 'cost_uncertain', 'rejected'));