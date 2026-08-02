import mongoose, { Schema } from 'mongoose';
import type { FederationBlockCategory } from '@mention/shared-types';
import {
  blockedDomainPurgeCountsSchema,
  type BlockedDomainPurgeCounts,
} from './BlockedDomainPurge';

/**
 * APPEND-ONLY history: one row per (domain, purge run), recording what that run
 * actually removed.
 *
 * WHY SEPARATE FROM THE LEDGER
 *   `BlockedDomainPurge` is a STATE machine — one row per domain, unique on
 *   domain, answering "what is the situation with this domain now". This is
 *   HISTORY, and the two are genuinely different: a domain can be blocked,
 *   purged, unblocked, and blocked again, which is two purges of the same domain
 *   with different results. Storing the counts on the state row would overwrite
 *   the first result with the second and quietly make any sum-per-domain wrong.
 *
 * WHY IT CARRIES THE POLICY'S OWN WORDS
 *   `reason`, `category` and `corroboratingSources` are copied from the policy
 *   entry AS IT READ AT THE TIME OF THE PURGE. Not denormalisation for speed —
 *   the published justification can later be reworded or the entry removed
 *   entirely, and the record of an irreversible deletion has to keep saying what
 *   it was done for. Reading them live would let the record change after the
 *   fact.
 */
export type BlockedDomainPurgeTrigger =
  /** The domain was newly added to the committed policy and reconciled automatically. */
  | 'policy_added'
  /** A reviewed one-shot, run by a person. */
  | 'manual';

export const BLOCKED_DOMAIN_PURGE_TRIGGERS: readonly BlockedDomainPurgeTrigger[] = [
  'policy_added',
  'manual',
];

export interface IBlockedDomainPurgeRun {
  /** Canonical domain, matching `getBlockedDomainPolicy()`'s output. */
  domain: string;
  /** Groups every domain swept by the same run. */
  runId: string;
  runAt: Date;
  trigger: BlockedDomainPurgeTrigger;
  removed: BlockedDomainPurgeCounts;
  /** The policy's public reason, as it read when this ran. */
  reason?: string;
  category?: FederationBlockCategory;
  /** Instances that had independently published the same decision. */
  corroboratingSources?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const blockedDomainPurgeRunSchema = new Schema<IBlockedDomainPurgeRun>({
  domain: { type: String, required: true },
  runId: { type: String, required: true },
  runAt: { type: Date, required: true },
  trigger: { type: String, required: true, enum: BLOCKED_DOMAIN_PURGE_TRIGGERS },
  removed: { type: blockedDomainPurgeCountsSchema, required: true },
  reason: { type: String },
  category: { type: String },
  corroboratingSources: { type: [String], default: undefined },
}, { timestamps: true, collection: 'blockeddomainpurgeruns' });

// One row per domain per run. Re-running a run that already recorded a domain
// updates that row rather than appending a duplicate, so a retried or resumed
// run cannot inflate a sum-per-domain.
blockedDomainPurgeRunSchema.index({ domain: 1, runId: 1 }, { unique: true });
// Serves both queries the transparency surface needs: the latest run for a
// domain, and every run for a domain to sum.
blockedDomainPurgeRunSchema.index({ domain: 1, runAt: -1 });

export const BlockedDomainPurgeRun = mongoose.model<IBlockedDomainPurgeRun>(
  'BlockedDomainPurgeRun',
  blockedDomainPurgeRunSchema,
);

export default BlockedDomainPurgeRun;
