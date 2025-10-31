import mongoose, { Document, Schema } from "mongoose";

/**
 * UserBehavior model tracks user interaction patterns for feed personalization
 * Similar to how Twitter/Facebook learns user preferences
 */
export interface IUserBehavior extends Document {
  oxyUserId: string; // Links to Oxy user
  // Interaction patterns
  preferredAuthors: Array<{
    authorId: string;
    interactionCount: number; // Total interactions with this author
    lastInteractionAt: Date;
    interactionTypes: {
      likes: number;
      reposts: number;
      comments: number;
      saves: number;
      shares: number;
    };
    weight: number; // Calculated relationship strength (0-1)
  }>;
  // Content preferences
  preferredTopics: Array<{
    topic: string; // Hashtag or keyword
    interactionCount: number;
    lastInteractionAt: Date;
    weight: number;
  }>;
  preferredPostTypes: {
    text: number;
    image: number;
    video: number;
    poll: number;
  };
  // Time-based preferences
  activeHours: Array<number>; // Hours 0-23 when user is most active
  preferredLanguages: Array<string>;
  // Engagement patterns
  averageEngagementTime: number; // Seconds spent viewing posts
  skipRate: number; // Percentage of posts skipped
  completionRate: number; // Percentage of posts fully viewed
  // Negative signals
  hiddenAuthors: Array<string>; // Authors whose posts user hides
  mutedAuthors: Array<string>;
  blockedAuthors: Array<string>;
  hiddenTopics: Array<string>;
  // Metadata
  lastUpdated: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AuthorPreferenceSchema = new Schema({
  authorId: { type: String, required: true },
  interactionCount: { type: Number, default: 0 },
  lastInteractionAt: { type: Date, default: Date.now },
  interactionTypes: {
    likes: { type: Number, default: 0 },
    reposts: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    saves: { type: Number, default: 0 },
    shares: { type: Number, default: 0 }
  },
  weight: { type: Number, default: 0, min: 0, max: 1 }
}, { _id: false });

const TopicPreferenceSchema = new Schema({
  topic: { type: String, required: true },
  interactionCount: { type: Number, default: 0 },
  lastInteractionAt: { type: Date, default: Date.now },
  weight: { type: Number, default: 0, min: 0, max: 1 }
}, { _id: false });

const UserBehaviorSchema = new Schema<IUserBehavior>({
  oxyUserId: { type: String, required: true, unique: true }, // unique: true automatically creates an index
  preferredAuthors: [AuthorPreferenceSchema],
  preferredTopics: [TopicPreferenceSchema],
  preferredPostTypes: {
    text: { type: Number, default: 0 },
    image: { type: Number, default: 0 },
    video: { type: Number, default: 0 },
    poll: { type: Number, default: 0 }
  },
  activeHours: [{ type: Number, min: 0, max: 23 }],
  preferredLanguages: [{ type: String }],
  averageEngagementTime: { type: Number, default: 0 },
  skipRate: { type: Number, default: 0, min: 0, max: 1 },
  completionRate: { type: Number, default: 0, min: 0, max: 1 },
  hiddenAuthors: [{ type: String }],
  mutedAuthors: [{ type: String }],
  blockedAuthors: [{ type: String }],
  hiddenTopics: [{ type: String }],
  lastUpdated: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Index for efficient lookups
// Note: oxyUserId index is automatically created by unique: true, no need to define it separately
UserBehaviorSchema.index({ 'preferredAuthors.authorId': 1 });

export default mongoose.model<IUserBehavior>("UserBehavior", UserBehaviorSchema);

