import mongoose, { Schema, Document } from "mongoose";

interface IBookmark extends Document {
  userId: mongoose.Types.ObjectId;
  postId: mongoose.Types.ObjectId;
}

const BookmarkSchema: Schema = new Schema(
  {
    userId: { type: mongoose.Types.ObjectId, ref: "User", required: true },
    postId: { type: mongoose.Types.ObjectId, ref: "Post", required: true },
  },
  { timestamps: true }
);

export default mongoose.model<IBookmark>("Bookmark", BookmarkSchema);
