import mongoose, { Schema, Document } from "mongoose";

export interface ILike extends Document {
  userId: string;
  postId: mongoose.Types.ObjectId;
  value: 1 | -1;
  /**
   * Originating feed surface (feed-descriptor string, e.g. `videos`, `for_you`,
   * `author|<id>`) the like happened on. Persisted for SURFACE-AWARE
   * recommendation attribution: a like from the reels surface contributes weakly
   * to "follow this author" candidates. Optional — absent on legacy likes and
   * on likes with no surface context (treated as a normal-surface like).
   */
  source?: string;
}

const LikeSchema: Schema = new Schema(
  {
    userId: { type: String, required: true },
    postId: { type: mongoose.Types.ObjectId, ref: "Post", required: true },
    value: { type: Number, enum: [1, -1], default: 1 },
    source: { type: String },
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