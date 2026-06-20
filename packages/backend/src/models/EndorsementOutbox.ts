import mongoose, { Document, Schema } from 'mongoose';

/**
 * Outbox for endorsement-signal pushes to Oxy (`POST /app-signals/ingest`).
 *
 * Mirrors {@link FederationDeliveryQueue}: each row is a unit of work that is
 * attempted immediately and retried with backoff until it succeeds. Unlike the
 * delivery queue, an endorsement push is DESIRED-STATE — the row records the
 * `(source, sourceId)` scope to re-sync, NOT a frozen edge list, so a retry
 * recomputes the CURRENT member set and is self-healing/idempotent.
 *
 * There is at most ONE row per `(source, sourceId)` (unique index). A new
 * mutation on an already-pending scope upserts the same row (bumping
 * `updatedAt` and re-arming it) rather than queuing duplicates.
 */

/** The membership model a scope belongs to. */
export type EndorsementSource = 'starterPack' | 'accountList';

export type EndorsementOutboxStatus = 'pending' | 'sent';

export interface IEndorsementOutbox extends Document {
  /** Which membership model the scope lives in. */
  source: EndorsementSource;
  /** The source document's `_id` (starter pack / list id) as a string. */
  sourceId: string;
  /** Pending = needs a (re)push; sent = last push succeeded. */
  status: EndorsementOutboxStatus;
  /** Number of failed push attempts since the last success. */
  attempts: number;
  /** Earliest time the next attempt may run (backoff gate). */
  nextAttemptAt: Date;
  lastAttemptAt?: Date;
  /** Last error message, when the most recent attempt failed. */
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Exponential backoff schedule for failed pushes, indexed by attempt count.
 * Mirrors the federation delivery backoff intent (minutes → hours) but the
 * desired-state nature means even an exhausted row is harmless to re-arm; the
 * drain job re-attempts pending rows whose `nextAttemptAt` has passed.
 */
const BACKOFF_INTERVALS_MS = [
  1 * 60 * 1000,        // 1 minute
  5 * 60 * 1000,        // 5 minutes
  30 * 60 * 1000,       // 30 minutes
  2 * 60 * 60 * 1000,   // 2 hours
  12 * 60 * 60 * 1000,  // 12 hours
];

/** Largest backoff used once the schedule is exhausted (re-arm, never drop). */
const MAX_BACKOFF_MS = BACKOFF_INTERVALS_MS[BACKOFF_INTERVALS_MS.length - 1];

/**
 * Compute the next attempt time for a given (1-based) attempt count. Clamps to
 * the last interval so an over-attempted row keeps retrying slowly rather than
 * being abandoned — desired-state pushes are cheap and self-healing.
 */
export function getEndorsementNextAttempt(attempts: number): Date {
  const index = Math.min(Math.max(attempts - 1, 0), BACKOFF_INTERVALS_MS.length - 1);
  const interval = attempts <= 0 ? 0 : BACKOFF_INTERVALS_MS[index] ?? MAX_BACKOFF_MS;
  return new Date(Date.now() + interval);
}

const EndorsementOutboxSchema = new Schema<IEndorsementOutbox>({
  source: { type: String, required: true, enum: ['starterPack', 'accountList'] },
  sourceId: { type: String, required: true },
  status: { type: String, default: 'pending', enum: ['pending', 'sent'], index: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, required: true, default: Date.now, index: true },
  lastAttemptAt: { type: Date },
  error: { type: String },
}, {
  timestamps: true,
});

// One row per scope; a new mutation upserts/re-arms it instead of duplicating.
EndorsementOutboxSchema.index({ source: 1, sourceId: 1 }, { unique: true });
// Drain query: pending rows due for an attempt, oldest first.
EndorsementOutboxSchema.index({ status: 1, nextAttemptAt: 1 });

export const EndorsementOutbox = mongoose.model<IEndorsementOutbox>(
  'EndorsementOutbox',
  EndorsementOutboxSchema,
);
export default EndorsementOutbox;
