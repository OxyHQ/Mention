-- oxy:deploy-phase=pre
-- A federated poll's per-option tally as its origin publishes it (an ActivityPub
-- Question's replies.totalItems). NULL on every local poll. The check validates
-- existing rows, all NULL, of a small table that is not on the hot list.
ALTER TABLE "poll_options" ADD COLUMN "federated_vote_count" integer;--> statement-breakpoint
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_federated_vote_count_check" CHECK ("poll_options"."federated_vote_count" is null or "poll_options"."federated_vote_count" >= 0);
