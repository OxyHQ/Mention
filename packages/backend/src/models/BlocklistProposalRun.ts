import mongoose, { Schema } from 'mongoose';
import type { SourceOutcome } from '../scripts/reportFederationBlocklistCandidates';

/**
 * APPEND-ONLY: one row per sweep of the published blocklists.
 *
 * WHY A RUN HISTORY AND NOT JUST THE PROPOSALS
 *   A sweep that finds nothing writes no proposal, which is indistinguishable
 *   from a sweep that never ran — and "it silently stopped running" is precisely
 *   the failure this whole mechanism exists to prevent. Every run is recorded
 *   whatever it found, so "when did we last actually look?" has an answer that
 *   does not depend on the answer being interesting.
 *
 * IT IS ALSO THE SCHEDULE
 *   The scheduler reads the latest `startedAt` to decide whether a sweep is due,
 *   rather than counting on a timer having stayed alive. A weekly `setInterval`
 *   in a service that redeploys several times a day never fires at all; a due
 *   time in the database survives every restart, needs no Redis, and behaves the
 *   same in every environment. See `services/federation/BlocklistProposalScheduler`.
 *
 * WHY THE SOURCE OUTCOMES ARE KEPT
 *   A run where nine of thirteen sources failed produces a thin candidate list
 *   that reads exactly like "there is nothing to block". Recording what each
 *   source answered is what lets a reader tell a quiet week from a broken poll.
 */
export type BlocklistProposalRunTrigger =
  /** The leader-gated sweep, on its own cadence. */
  | 'scheduled'
  /** A person ran it, through `scripts/reviewFederationBlocklistProposals`. */
  | 'manual';

export const BLOCKLIST_PROPOSAL_RUN_TRIGGERS: readonly BlocklistProposalRunTrigger[] = [
  'scheduled',
  'manual',
];

const SOURCE_OUTCOME_VALUES = {
  published: 'published',
  'not-published': 'not-published',
  failed: 'failed',
} as const satisfies Record<SourceOutcome, SourceOutcome>;

/**
 * The vocabulary is the poller's, not ours — `not-published` (the instance
 * serves no blocklist) is an ordinary outcome and must never be confused with
 * `failed`.
 */
export const BLOCKLIST_SOURCE_OUTCOMES: readonly SourceOutcome[] = Object.values(
  SOURCE_OUTCOME_VALUES,
);

/** What one source contributed to one run. */
export interface BlocklistProposalRunSource {
  instance: string;
  /** Who operates it, per `connectors/activitypub/blocklistSourceRegistry`. */
  operator: string;
  outcome: SourceOutcome;
  /** Entries accepted from its published list. */
  entries: number;
  /** Short detail for a `failed` outcome. */
  detail?: string;
}

const runSourceSchema = new Schema<BlocklistProposalRunSource>({
  instance: { type: String, required: true },
  operator: { type: String, required: true },
  outcome: { type: String, required: true, enum: BLOCKLIST_SOURCE_OUTCOMES },
  entries: { type: Number, required: true },
  detail: { type: String },
}, { _id: false });

/**
 * What the run did, in the terms a reader would ask about.
 *
 * `suppressedDeclined` and `suppressedBlocked` are counted rather than listed:
 * a reviewer must be able to see that the list is short BECAUSE decisions were
 * already made, without those decisions being re-litigated every week.
 */
export interface BlocklistProposalRunCounts {
  /** Domains named by at least one source at a corroborating severity. */
  domainsObserved: number;
  /** Domains that cleared the DISTINCT-OPERATOR suspend threshold. */
  clearedOperatorThreshold: number;
  /** Proposals this run opened for the first time. */
  opened: number;
  /** Open proposals after the run — including ones still waiting from before. */
  pending: number;
  /** Cleared the threshold but a person had already declined them. */
  suppressedDeclined: number;
  /** Cleared the threshold but our own policy already refuses them. */
  suppressedBlocked: number;
  /** Open proposals whose corroboration no longer holds. */
  lapsed: number;
  /** Open proposals whose domain our policy now refuses. */
  adopted: number;
}

const runCountsSchema = new Schema<BlocklistProposalRunCounts>({
  domainsObserved: { type: Number, required: true },
  clearedOperatorThreshold: { type: Number, required: true },
  opened: { type: Number, required: true },
  pending: { type: Number, required: true },
  suppressedDeclined: { type: Number, required: true },
  suppressedBlocked: { type: Number, required: true },
  lapsed: { type: Number, required: true },
  adopted: { type: Number, required: true },
}, { _id: false });

export interface IBlocklistProposalRun {
  /** Unique per run, so a row cannot be recorded twice. */
  runId: string;
  trigger: BlocklistProposalRunTrigger;
  startedAt: Date;
  finishedAt: Date;
  /** Distinct operators required to suspend a domain before it is proposed. */
  minOperators: number;
  sources: BlocklistProposalRunSource[];
  counts: BlocklistProposalRunCounts;
  /**
   * False when the run could not produce a trustworthy list — fewer sources
   * published than the threshold needs, so no domain COULD clear it and an empty
   * result reads exactly like "there is nothing to block".
   */
  ok: boolean;
  /** Why `ok` is false. */
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const blocklistProposalRunSchema = new Schema<IBlocklistProposalRun>({
  runId: { type: String, required: true, unique: true },
  trigger: { type: String, required: true, enum: BLOCKLIST_PROPOSAL_RUN_TRIGGERS },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date, required: true },
  minOperators: { type: Number, required: true },
  sources: { type: [runSourceSchema], required: true, default: [] },
  counts: { type: runCountsSchema, required: true },
  ok: { type: Boolean, required: true },
  failureReason: { type: String },
}, { timestamps: true, collection: 'blocklistproposalruns' });

// The scheduler's only query: when did the last sweep start?
blocklistProposalRunSchema.index({ startedAt: -1 });

export const BlocklistProposalRun = mongoose.model<IBlocklistProposalRun>(
  'BlocklistProposalRun',
  blocklistProposalRunSchema,
);

export default BlocklistProposalRun;
