import mongoose, { Schema } from 'mongoose';

export const POST_RECENT_REPLIER_LIMIT = 3;
export const POST_RECENT_REPLIER_COLLECTION = 'post_recent_repliers';
export const POST_RECENT_REPLIER_INDEX = 'post_recent_repliers_post_id_unique';

export interface RecentReplierEntry {
  oxyUserId: string;
  repliedAt: Date;
}

export interface IPostRecentReplier {
  postId: string;
  repliers: RecentReplierEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const recentReplierEntrySchema = new Schema<RecentReplierEntry>(
  {
    oxyUserId: { type: String, required: true },
    repliedAt: { type: Date, required: true },
  },
  { _id: false },
);

const postRecentReplierSchema = new Schema<IPostRecentReplier>(
  {
    postId: { type: String, required: true },
    repliers: {
      type: [recentReplierEntrySchema],
      default: [],
      validate: {
        validator: (entries: RecentReplierEntry[]) =>
          entries.length <= POST_RECENT_REPLIER_LIMIT,
        message: `repliers must contain at most ${POST_RECENT_REPLIER_LIMIT} entries`,
      },
    },
  },
  {
    // This read model is fail-soft. Never queue hydration/write work behind a
    // disconnected Mongo client, where Mongoose's default buffering can stall a
    // request for 10 seconds.
    bufferCommands: false,
    collection: POST_RECENT_REPLIER_COLLECTION,
    timestamps: true,
  },
);

postRecentReplierSchema.index(
  { postId: 1 },
  { unique: true, name: POST_RECENT_REPLIER_INDEX },
);

export const PostRecentReplier =
  (mongoose.models.PostRecentReplier as mongoose.Model<IPostRecentReplier> | undefined) ??
  mongoose.model<IPostRecentReplier>('PostRecentReplier', postRecentReplierSchema);

export default PostRecentReplier;
