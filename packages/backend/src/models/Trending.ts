import mongoose, { Document, Schema } from "mongoose";

export enum TrendingType {
  HASHTAG = 'hashtag',
  TOPIC = 'topic'
}

export enum TimeWindow {
  ONE_HOUR = '1h',
  SIX_HOURS = '6h',
  TWENTY_FOUR_HOURS = '24h'
}

export interface ITrending extends Document {
  type: TrendingType;
  name: string;
  score: number;
  volume: number;
  momentum: number;
  rank: number;
  timeWindow: TimeWindow;
  updatedAt: Date;
}

const TrendingSchema = new Schema({
  type: {
    type: String,
    enum: Object.values(TrendingType),
    required: true
  },
  name: {
    type: String,
    required: true
  },
  score: {
    type: Number,
    required: true,
    index: true
  },
  volume: {
    type: Number,
    required: true,
    default: 0
  },
  momentum: {
    type: Number,
    required: true,
    default: 0
  },
  rank: {
    type: Number,
    required: true
  },
  timeWindow: {
    type: String,
    enum: Object.values(TimeWindow),
    required: true,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index for efficient querying by timeWindow and score
TrendingSchema.index({ timeWindow: 1, score: -1 });

// Compound index for unique trending items per time window
TrendingSchema.index({ type: 1, name: 1, timeWindow: 1 }, { unique: true });

export default mongoose.model<ITrending>("Trending", TrendingSchema);
