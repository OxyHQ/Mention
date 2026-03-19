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
