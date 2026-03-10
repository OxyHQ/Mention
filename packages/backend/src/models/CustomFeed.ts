import mongoose, { Schema, Document } from 'mongoose';

export const FEED_CATEGORIES = ['news', 'tech', 'culture', 'finance', 'health', 'sports', 'entertainment', 'other'] as const;
export type FeedCategory = typeof FEED_CATEGORIES[number];

export interface ICustomFeed extends Document {
  ownerOxyUserId: string;
  title: string;
  description?: string;
  isPublic: boolean;
  memberOxyUserIds: string[];
  sourceListIds?: string[]; // AccountList sources used by this feed
  keywords?: string[];
  includeReplies?: boolean;
  includeReposts?: boolean;
  includeMedia?: boolean;
  language?: string;
  category?: FeedCategory;
  tags: string[];
  coverImage?: string;
  subscriberCount: number;
  averageRating: number;
  ratingsCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const CustomFeedSchema = new Schema<ICustomFeed>({
  ownerOxyUserId: { type: String, required: true, index: true },
  title: { type: String, required: true },
  description: { type: String },
  isPublic: { type: Boolean, default: false, index: true },
  memberOxyUserIds: { type: [String], default: [], index: true },
  sourceListIds: { type: [String], default: [] },
  keywords: { type: [String], default: [] },
  includeReplies: { type: Boolean, default: true },
  includeReposts: { type: Boolean, default: true },
  includeMedia: { type: Boolean, default: true },
  language: { type: String },
  category: { type: String, enum: FEED_CATEGORIES },
  tags: { type: [String], default: [] },
  coverImage: { type: String },
  subscriberCount: { type: Number, default: 0 },
  averageRating: { type: Number, default: 0 },
  ratingsCount: { type: Number, default: 0 },
}, { timestamps: true });

CustomFeedSchema.index({ ownerOxyUserId: 1, createdAt: -1 });
CustomFeedSchema.index({ isPublic: 1, createdAt: -1 });
CustomFeedSchema.index({ isPublic: 1, category: 1, subscriberCount: -1 });

export const CustomFeed = mongoose.model<ICustomFeed>('CustomFeed', CustomFeedSchema);
export default CustomFeed;
