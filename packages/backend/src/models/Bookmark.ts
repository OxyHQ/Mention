import mongoose, { Schema, Document } from "mongoose";

interface IBookmark extends Document {
  userId: string;
  postId: mongoose.Types.ObjectId;
  folder: string | null;
  createdAt?: Date;
  updatedAt?: Date;
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

// Exported BOTH ways on purpose. Static importers use the default; the lazy
// `await import()` in the feed sources must destructure the NAMED export,
// because Node's CommonJS-to-ESM interop binds a dynamic import's `default` to
// the whole `module.exports`, not to the module's own default export.
export const Bookmark = mongoose.model<IBookmark>("Bookmark", BookmarkSchema);

export default Bookmark;
