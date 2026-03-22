/**
 * FeedInteraction Model
 *
 * Tracks feed impressions, clicks, and engagement for ranking feedback.
 * MTN Protocol analytics.
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface IFeedInteraction extends Document {
  userId: string;
  feedDescriptor: string;
  postUri: string;
  event: 'impression' | 'click' | 'like' | 'reply' | 'repost' | 'save';
  durationMs?: number;
  createdAt: Date;
}

const feedInteractionSchema = new Schema<IFeedInteraction>(
  {
    userId: { type: String, required: true, index: true },
    feedDescriptor: { type: String, required: true },
    postUri: { type: String, required: true },
    event: {
      type: String,
      enum: ['impression', 'click', 'like', 'reply', 'repost', 'save'],
      required: true,
    },
    durationMs: { type: Number },
  },
  { timestamps: true }
);

feedInteractionSchema.index({ userId: 1, createdAt: -1 });
feedInteractionSchema.index({ postUri: 1, event: 1 });
// TTL: auto-delete after 90 days
feedInteractionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const FeedInteraction = mongoose.model<IFeedInteraction>('FeedInteraction', feedInteractionSchema);
