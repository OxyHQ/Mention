import mongoose, { Schema, Document } from "mongoose";

interface ILike extends Document {
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

export default mongoose.model<ILike>("Like", LikeSchema);