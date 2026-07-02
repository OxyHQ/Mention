/**
 * AuthorFollowerSnapshot
 *
 * A rolling time series of per-author follower counts, sampled by the
 * leader-gated {@link ../services/followerSnapshotJob}. The `risingCreators` feed
 * source computes each active author's follower-growth delta over a window from
 * these snapshots (current − prior) to surface up-and-coming creators.
 *
 * Retention is bounded by a TTL index (snapshots older than the retention window
 * auto-expire), so the collection never grows without bound.
 */

import mongoose, { Schema, Document } from 'mongoose';

/** Retention for a single snapshot before the TTL index removes it. 30 days. */
const SNAPSHOT_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface IAuthorFollowerSnapshot extends Document {
  oxyUserId: string;
  followerCount: number;
  at: Date;
}

const authorFollowerSnapshotSchema = new Schema<IAuthorFollowerSnapshot>({
  oxyUserId: { type: String, required: true, index: true },
  followerCount: { type: Number, required: true, min: 0 },
  at: { type: Date, required: true, default: Date.now },
});

// Per-author time-ordered lookup (delta computation reads first/last in a window).
authorFollowerSnapshotSchema.index({ oxyUserId: 1, at: -1 });
// Rolling retention — expire individual snapshots after the retention window.
authorFollowerSnapshotSchema.index({ at: 1 }, { expireAfterSeconds: SNAPSHOT_TTL_SECONDS });

export const AuthorFollowerSnapshot = mongoose.model<IAuthorFollowerSnapshot>(
  'AuthorFollowerSnapshot',
  authorFollowerSnapshotSchema,
);
