import mongoose, { Document, Schema } from 'mongoose';

/**
 * Retention for a generated trend summary, in seconds (30 days).
 *
 * Long enough that a story people return to keeps its summary, short enough
 * that a collection of one-off explanations for terms nobody will search again
 * stays bounded. A summary is derived text, so losing an old one costs nothing
 * but a regeneration that demand would have to justify all over again.
 */
export const TREND_SUMMARY_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface TrendSummaryRecord {
  _id: mongoose.Types.ObjectId;
  /** The trending term this explains. */
  term: string;
  /**
   * Onset of the RUN the summary was written for.
   *
   * Part of the identity, not metadata. `orioles` is a trade this week and a
   * no-hitter next month; a summary written for one would be actively wrong for
   * the other, and keying on the term alone would serve it anyway. A new run
   * therefore earns a new summary — and has to clear the demand threshold again
   * to get one.
   */
  runStartedAt: Date;
  description: string;
  generatedAt: Date;
}

export interface ITrendSummary extends Omit<TrendSummaryRecord, '_id'>, Document {}

const TrendSummarySchema = new Schema({
  term: { type: String, required: true },
  runStartedAt: { type: Date, required: true },
  description: { type: String, required: true },
  generatedAt: { type: Date, required: true },
});

// The identity of a summary, and the thing that makes generation
// idempotent-by-construction: a race between two tasks that both cleared the
// threshold ends with one insert and one duplicate-key error, never two
// generations stored. NOTE: `autoIndex`/`autoCreate` are OFF in production —
// created by migration `0015-trend-summary-indexes`.
TrendSummarySchema.index({ term: 1, runStartedAt: 1 }, { unique: true });

// TTL: derived text, reaped at the storage layer so nothing has to remember to
// clean it up.
TrendSummarySchema.index({ generatedAt: 1 }, { expireAfterSeconds: TREND_SUMMARY_TTL_SECONDS });

export default mongoose.model<ITrendSummary>('TrendSummary', TrendSummarySchema);
