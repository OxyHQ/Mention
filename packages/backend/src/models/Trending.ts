import mongoose, { Document, Schema } from "mongoose";

export enum TrendingType {
  HASHTAG = 'hashtag',
  TOPIC = 'topic',
  ENTITY = 'entity',
}

export interface ITrending extends Document {
  type: TrendingType;
  name: string;
  description: string;
  score: number;
  volume: number;
  momentum: number;
  rank: number;
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
  calculatedAt: {
    type: Date,
    required: true,
    index: true,
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

export default mongoose.model<ITrending>("Trending", TrendingSchema);

// ── Trend Batch (one doc per calculation cycle, stores the overall summary) ──

export interface ITrendBatch extends Document {
  calculatedAt: Date;
  summary: string;
}

const TrendBatchSchema = new Schema({
  calculatedAt: {
    type: Date,
    required: true,
    unique: true,
    index: true,
  },
  summary: {
    type: String,
    default: '',
  },
});

export const TrendBatch = mongoose.model<ITrendBatch>("TrendBatch", TrendBatchSchema);
