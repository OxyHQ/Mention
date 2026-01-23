import mongoose, { Schema, Document } from "mongoose";

interface IFeedLike extends Document {
  userId: string;
  feedId: mongoose.Types.ObjectId;
}

const FeedLikeSchema: Schema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    feedId: { type: mongoose.Types.ObjectId, ref: "CustomFeed", required: true, index: true },
  },
  { timestamps: true }
);

// Create a compound index to ensure a user can only like a feed once
FeedLikeSchema.index({ userId: 1, feedId: 1 }, { unique: true });

export const FeedLike = mongoose.model<IFeedLike>("FeedLike", FeedLikeSchema);
export default FeedLike;















