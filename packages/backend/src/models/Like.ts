import mongoose, { Schema, Document } from "mongoose";

export interface ILike extends Document {
  userId: string;
  postId: mongoose.Types.ObjectId;
  value: 1 | -1;
}

const LikeSchema: Schema = new Schema(
  {
    userId: { type: String, required: true },
    postId: { type: mongoose.Types.ObjectId, ref: "Post", required: true },
    value: { type: Number, enum: [1, -1], default: 1 },
  },
  { timestamps: true }
);

// Create a compound index to ensure a user can only like a post once
LikeSchema.index({ userId: 1, postId: 1 }, { unique: true });

// Per-post index so counting/listing likes by post (the likes list endpoint and
// engagement reconciliation) is efficient. The compound {userId, postId} index
// cannot serve postId-only queries because postId is not its prefix.
LikeSchema.index({ postId: 1 });

export default mongoose.model<ILike>("Like", LikeSchema);