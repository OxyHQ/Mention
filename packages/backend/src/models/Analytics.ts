import mongoose, { Document, Schema } from "mongoose";

export interface IAnalytics extends Document {
  userID: mongoose.Schema.Types.ObjectId;
  period: string; // 'daily', 'weekly', 'monthly', 'yearly'
  date: Date;
  stats: {
    postViews: number;
    profileViews: number;
    engagement: {
      likes: number;
      replies: number;
      reposts: number;
      quotes: number;
      bookmarks: number;
    };
    reach: {
      impressions: number;
      uniqueViewers: number;
    };
    demographics: {
      countries: Map<string, number>;
      languages: Map<string, number>;
    };
    peakActivity: {
      hour: number;
      count: number;
    };
  };
}

const AnalyticsSchema = new Schema({
  userID: { type: Schema.Types.ObjectId, ref: "User", required: true },
  period: { type: String, required: true, enum: ["daily", "weekly", "monthly", "yearly"] },
  date: { type: Date, required: true },
  stats: {
    postViews: { type: Number, default: 0 },
    profileViews: { type: Number, default: 0 },
    engagement: {
      likes: { type: Number, default: 0 },
      replies: { type: Number, default: 0 },
      reposts: { type: Number, default: 0 },
      quotes: { type: Number, default: 0 },
      bookmarks: { type: Number, default: 0 }
    },
    reach: {
      impressions: { type: Number, default: 0 },
      uniqueViewers: { type: Number, default: 0 }
    },
    demographics: {
      countries: { type: Map, of: Number, default: new Map() },
      languages: { type: Map, of: Number, default: new Map() }
    },
    peakActivity: {
      hour: { type: Number, default: 0 },
      count: { type: Number, default: 0 }
    }
  }
}, {
  timestamps: true
});

// Create compound index for efficient querying
AnalyticsSchema.index({ userID: 1, period: 1, date: 1 }, { unique: true });

export default mongoose.model<IAnalytics>("Analytics", AnalyticsSchema);