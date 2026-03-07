import mongoose, { Schema, Document } from "mongoose";

interface IFeedReview extends Document {
  feedId: mongoose.Types.ObjectId;
  reviewerId: string;
  rating: number;
  reviewText?: string;
}

const FeedReviewSchema: Schema = new Schema(
  {
    feedId: { type: mongoose.Types.ObjectId, ref: "CustomFeed", required: true, index: true },
    reviewerId: { type: String, required: true, index: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    reviewText: { type: String, maxlength: 500 },
  },
  { timestamps: true }
);

// Ensure a reviewer can only submit one review per feed
FeedReviewSchema.index({ feedId: 1, reviewerId: 1 }, { unique: true });

export const FeedReview = mongoose.model<IFeedReview>("FeedReview", FeedReviewSchema);
export default FeedReview;
