import mongoose, { Schema, Document } from "mongoose";

interface ILike extends Document {
  userId: mongoose.Types.ObjectId;
  postId: mongoose.Types.ObjectId;
}

const LikeSchema: Schema = new Schema(
  {
    userId: { type: mongoose.Types.ObjectId, ref: "User", required: true },
    postId: { type: mongoose.Types.ObjectId, ref: "Post", required: true },
  },
  { timestamps: true }
);

// Create a compound index to ensure a user can only like a post once
LikeSchema.index({ userId: 1, postId: 1 }, { unique: true });

export default mongoose.model<ILike>("Like", LikeSchema);