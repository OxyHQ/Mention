import mongoose, { Document, Schema } from "mongoose";

export enum TrendingType {
  HASHTAG = 'hashtag',
  TOPIC = 'topic',
  ENTITY = 'entity',
}

/**
 * Retention window for trending rows, in seconds (90 days).
 *
 * The trending job inserts a full batch every 30 minutes, so the `Trending`
 * collection would grow without bound. A TTL index on `calculatedAt` (declared
 * below) reaps rows older than this window at the storage layer, keeping the
 * collection — and therefore every history scan — small. The value is exported
 * so the history aggregation in `TrendingService` can key its query window off
 * the SAME retention bound (the query window must never exceed what is retained).
 */
export const TRENDING_TTL_SECONDS = 90 * 24 * 60 * 60;

export interface ITrending extends Document {
  type: TrendingType;
  name: string;
  description: string;
  score: number;
  volume: number;
  momentum: number;
  rank: number;
  topicId?: mongoose.Types.ObjectId;
  calculatedAt: Date;
  updatedAt: Date;
}

const TrendingSchema = new Schema({
  type: {
    type: String,
    enum: Object.values(TrendingType),
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    default: '',
  },
  score: {
    type: Number,
    required: true,
    index: true,
  },
  volume: {
    type: Number,
    required: true,
    default: 0,
  },
  momentum: {
    type: Number,
    required: true,
    default: 0,
  },
  rank: {
    type: Number,
    required: true,
  },
  topicId: {
    type: Schema.Types.ObjectId,
    ref: 'Topic',
    index: true,
  },
  calculatedAt: {
    type: Date,
    required: true,
    // No inline `index: true` here — the single-field `{ calculatedAt: 1 }`
    // index is declared below WITH `expireAfterSeconds` (TTL). Declaring both
    // would produce two indexes with the same key pattern and conflict.
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Efficient query for latest batch and history browsing
TrendingSchema.index({ calculatedAt: -1, score: -1 });

// Unique constraint: same trend name can't appear twice in the same batch
TrendingSchema.index({ name: 1, calculatedAt: 1 }, { unique: true });

// TTL index: MongoDB's background monitor reaps rows older than the retention
// window so the collection stays bounded. This is ALSO the ascending
// single-field `{ calculatedAt: 1 }` index, so range queries such as the
// history aggregation's `{ calculatedAt: { $gte: cutoff } }` use it directly.
// NOTE: `autoIndex`/`autoCreate` are OFF in production — this index is created
// by migration `0003-trending-ttl-index`, not on model load.
TrendingSchema.index({ calculatedAt: 1 }, { expireAfterSeconds: TRENDING_TTL_SECONDS });

export default mongoose.model<ITrending>("Trending", TrendingSchema);
