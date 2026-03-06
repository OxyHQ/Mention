import mongoose, { Schema, Document } from "mongoose";

interface IBookmark extends Document {
  userId: string;
  postId: mongoose.Types.ObjectId;
  folder: string | null;
}

const BookmarkSchema: Schema = new Schema(
  {
    userId: { type: String, required: true },
    postId: { type: mongoose.Types.ObjectId, ref: "Post", required: true },
    folder: { type: String, default: null, trim: true, maxlength: 100 },
  },
  { timestamps: true }
);

// Create a compound index to ensure a user can only bookmark a post once
BookmarkSchema.index({ userId: 1, postId: 1 }, { unique: true });
// Index for querying user's bookmarks
BookmarkSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model<IBookmark>("Bookmark", BookmarkSchema);
