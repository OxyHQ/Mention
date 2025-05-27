import mongoose, { Schema, Document } from "mongoose";

interface IBookmark extends Document {
  userId: string;
  postId: mongoose.Types.ObjectId;
}

const BookmarkSchema: Schema = new Schema(
  {
    userId: { type: String, required: true },
    postId: { type: mongoose.Types.ObjectId, ref: "Post", required: true },
  },
  { timestamps: true }
);

export default mongoose.model<IBookmark>("Bookmark", BookmarkSchema);
