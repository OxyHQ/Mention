import mongoose, { Schema } from 'mongoose';
import { POST_RECENT_REPLIER_LIMIT } from '../db/schema/postContent';

/**
 * The Mongo half of the recent-replier projection.
 *
 * WRITE-DEAD ON THIS BRANCH, and NOT YET in production — the distinction is
 * load-bearing and this docblock previously blurred it. On `drizzle/foundation`
 * `PostRecentReplierService` and `EngagementProjectionReconciliationService`
 * maintain `post_recent_repliers` in Postgres, so nothing here may be written
 * to. In PRODUCTION the port has never deployed: the Mongo image is live, this
 * collection holds 139,340 documents (measured 2026-08-02) and the Postgres
 * table is EMPTY.
 *
 * That matters to anyone reasoning about the cutover, which is why it is stated
 * rather than left to be inferred. "The live services maintain it" describes the
 * branch; read as a statement about the system it inverts the direction of the
 * copy. The backfill runs during a freeze into an empty table, so there are no
 * live writers to order against — see `db/backfill/plans/content.ts`.
 *
 * This model also survives because the historical Mongo migration
 * `0009-post-recent-repliers` names its collection and index, and
 * `scripts/lib/adminDeletionPreflight` still enumerates the Mongo collections.
 * Both belong to the cutover/cleanup batch.
 *
 * The cap is imported rather than redeclared — one constant, and `db/schema`
 * owns it now that the authoritative table lives there.
 */
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
