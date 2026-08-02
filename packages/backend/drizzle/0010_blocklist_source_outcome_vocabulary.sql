-- `blocklist_proposal_run_sources.outcome` was constrained to a vocabulary
-- nothing produces: `published | unavailable | unparseable | empty`. The real
-- one belongs to the poller (`scripts/reportFederationBlocklistCandidates.ts`,
-- `export type SourceOutcome`) and is `published | not-published | failed`, from
-- which `models/BlocklistProposalRun.ts` derives its Mongoose enum.
--
-- Past `published` the two sets do not overlap, so the CHECK would have refused
-- every row the backfill copies (`backfill/plans/blocklist.ts` takes `outcome`
-- verbatim) and the drizzle column type would have refused every write from the
-- ported call sites. Additive rather than an edit to `0008`, so that migration's
-- hash and anything that already applied it stay intact.
ALTER TABLE "blocklist_proposal_run_sources" DROP CONSTRAINT "blocklist_proposal_run_sources_outcome_check";--> statement-breakpoint
ALTER TABLE "blocklist_proposal_run_sources" ADD CONSTRAINT "blocklist_proposal_run_sources_outcome_check" CHECK ("blocklist_proposal_run_sources"."outcome" in ('published', 'not-published', 'failed'));
