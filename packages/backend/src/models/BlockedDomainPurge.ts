import mongoose, { Schema } from 'mongoose';

/**
 * One row per domain the blocklist policy has ever named, recording whether its
 * already-ingested content has been purged and what that purge removed.
 *
 * WHY A LEDGER AND NOT A MIGRATION
 *   A migration runs once for a fixed id. The blocklist gains domains over time,
 *   so "purge what was newly blocked" is a RECONCILIATION against a moving
 *   policy, not a one-time schema step. This collection is what makes that
 *   reconciliation cheap (a set difference, not a re-scan of every domain ever
 *   blocked) and auditable (an automatic deletion is never "it vanished and
 *   nobody knows when or why").
 *
 * DELETION IS ONE-WAY
 *   Removing a domain from the policy file UNDOES NOTHING. It sets
 *   {@link IBlockedDomainPurge.inPolicy} to false and stops there: content that
 *   was deleted is gone, and no code path in this system restores it. The flag
 *   exists so a domain REMOVED and later RE-ADDED is recognised as newly blocked
 *   again — content can have arrived while it was unblocked, and that content
 *   must be purged on the second block just as it was on the first.
 */
export type BlockedDomainPurgeState =
  /**
   * Present in the policy the first time this ledger was ever built. NOT purged
   * automatically: the backlog that accumulated before this mechanism existed is
   * reviewed and run by a person, because "everything blocked so far" is exactly
   * the batch an unattended run should never take on its own.
   */
  | 'baseline'
  /** Newly added to the policy; awaiting an automatic purge. */
  | 'pending'
  /** Claimed by a run that has not reported back. Re-armed if that run died. */
  | 'in_progress'
  /** Content removed. Terminal unless the domain leaves and re-enters the policy. */
  | 'purged'
  /** The circuit breaker refused: the blast radius needs a human. */
  | 'held'
  /** The purge was attempted and errored. Retried on the next reconciliation. */
  | 'failed';

export const BLOCKED_DOMAIN_PURGE_STATES: readonly BlockedDomainPurgeState[] = [
  'baseline',
  'pending',
  'in_progress',
  'purged',
  'held',
  'failed',
];

/**
 * What a purge removed for one domain.
 *
 * Deliberately NARROWER than the script's internal counters: this is the record
 * a human review and the public transparency surface read, so it carries the
 * numbers that answer "what was lost" rather than every internal tally. Widening
 * the script's counters must not silently change a persisted shape.
 */
export interface BlockedDomainPurgeCounts {
  posts: number;
  actors: number;
  boosts: number;
  likes: number;
  notifications: number;
  mediaCacheRows: number;
  /** Local posts left pointing at removed content (replies + quotes + thread roots). */
  localContentKept: number;
  /** Accepted outbound follows removed — a local user had followed an account there. */
  localFollowsRemoved: number;
}

/**
 * The tallies {@link toLedgerCounts} reads, described structurally rather than
 * imported from the purge script.
 *
 * Both the script and the reconciler satisfy this by shape, so the persisted
 * record can be written from either without the model depending on a script or
 * the script depending on the reconciler — there is no runtime cycle to create.
 */
export interface PurgeTallies {
  posts: number;
  orphanPosts: number;
  actors: number;
  boostsByOthers: number;
  likesOnRemovedPosts: number;
  likesByBlockedActors: number;
  notificationsByEntity: number;
  notificationsByActor: number;
  mediaCacheRows: number;
  repliesByOthersKept: number;
  quotesByOthersKept: number;
  threadRootsKept: number;
  localFollowsRemoved: number;
}

/**
 * Narrow a run's internal tallies to the shape this ledger persists.
 *
 * Deliberately lossy: the persisted record answers "what was lost" for a human
 * review and a public transparency surface, so adding an internal counter to the
 * purge must not silently widen a stored document.
 */
export function toLedgerCounts(totals: PurgeTallies): BlockedDomainPurgeCounts {
  return {
    posts: totals.posts + totals.orphanPosts,
    actors: totals.actors,
    boosts: totals.boostsByOthers,
    likes: totals.likesOnRemovedPosts + totals.likesByBlockedActors,
    notifications: totals.notificationsByEntity + totals.notificationsByActor,
    mediaCacheRows: totals.mediaCacheRows,
    localContentKept:
      totals.repliesByOthersKept + totals.quotesByOthersKept + totals.threadRootsKept,
    localFollowsRemoved: totals.localFollowsRemoved,
  };
}

export interface IBlockedDomainPurge {
  /** Canonical domain: lowercase, no trailing dot, no `www.` prefix. */
  domain: string;
  /** Whether the domain was in the policy at the last reconciliation. */
  inPolicy: boolean;
  state: BlockedDomainPurgeState;
  /** When this domain was first seen in the policy. */
  firstObservedAt: Date;
  /** When the reconciler last saw it in the policy. */
  lastObservedAt: Date;
  /** Set when a run claims the row, so a dead run's claim can be re-armed. */
  claimedAt?: Date;
  /** The run that claimed or completed this row — the audit join key. */
  runId?: string;
  /** When the content was removed. */
  purgedAt?: Date;
  /** Why the circuit breaker refused, when `state` is `held`. */
  heldReason?: string;
  /** The error a `failed` attempt reported. */
  failureReason?: string;
  /**
   * What the dry-run measurement predicted. Kept on the STATE row because it is
   * the evidence for the current state — specifically, what the circuit breaker
   * saw when it refused. What a run actually REMOVED is history and lives on
   * `BlockedDomainPurgeRun`, so a domain blocked twice keeps both results.
   */
  measured?: BlockedDomainPurgeCounts;
  createdAt: Date;
  updatedAt: Date;
}

export const blockedDomainPurgeCountsSchema = new Schema<BlockedDomainPurgeCounts>({
  posts: { type: Number, required: true, default: 0 },
  actors: { type: Number, required: true, default: 0 },
  boosts: { type: Number, required: true, default: 0 },
  likes: { type: Number, required: true, default: 0 },
  notifications: { type: Number, required: true, default: 0 },
  mediaCacheRows: { type: Number, required: true, default: 0 },
  localContentKept: { type: Number, required: true, default: 0 },
  localFollowsRemoved: { type: Number, required: true, default: 0 },
}, { _id: false });

const blockedDomainPurgeSchema = new Schema<IBlockedDomainPurge>({
  domain: { type: String, required: true },
  inPolicy: { type: Boolean, required: true, default: true },
  state: {
    type: String,
    required: true,
    enum: BLOCKED_DOMAIN_PURGE_STATES,
    default: 'pending',
  },
  firstObservedAt: { type: Date, required: true },
  lastObservedAt: { type: Date, required: true },
  claimedAt: { type: Date },
  runId: { type: String },
  purgedAt: { type: Date },
  heldReason: { type: String },
  failureReason: { type: String },
  measured: { type: blockedDomainPurgeCountsSchema, default: undefined },
}, { timestamps: true, collection: 'blockeddomainpurges' });

// The reconciler's whole cheapness rests on this: one indexed lookup per policy
// domain instead of re-measuring every domain ever blocked.
blockedDomainPurgeSchema.index({ domain: 1 }, { unique: true });
// The claim/re-arm sweep reads by state.
blockedDomainPurgeSchema.index({ state: 1, claimedAt: 1 });

export const BlockedDomainPurge = mongoose.model<IBlockedDomainPurge>(
  'BlockedDomainPurge',
  blockedDomainPurgeSchema,
);

export default BlockedDomainPurge;
