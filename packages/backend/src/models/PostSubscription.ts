import mongoose, { Document, Schema } from 'mongoose';

export interface IPostSubscription extends Document {
  subscriberId: string; // user who wants notifications
  authorId: string;     // author being followed for posts
  createdAt: Date;
  updatedAt: Date;
}

const PostSubscriptionSchema = new Schema<IPostSubscription>({
  subscriberId: { type: String, required: true, index: true },
  authorId: { type: String, required: true, index: true },
}, { timestamps: true });

// Unique constraint to prevent duplicates
PostSubscriptionSchema.index({ subscriberId: 1, authorId: 1 }, { unique: true });

export const PostSubscription = mongoose.model<IPostSubscription>('PostSubscription', PostSubscriptionSchema);
export default PostSubscription;
