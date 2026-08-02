/**
 * LaneMute — one reader silencing one lane of one publisher.
 *
 * A reader who likes most of what somebody writes, but not one carriageway of
 * it, can drop that carriageway out of their feeds without unfollowing.
 *
 * Why this is its own collection and not a field on something that already
 * exists — each of the three candidates fails differently, and two of them fail
 * SILENTLY:
 *
 *  - **Not `Mute`.** `UserPrivacyManager.loadPrivacyState` reads its `mutedId`
 *    as an Oxy USER id, funnels it into `excludedUserIds`, and compares that
 *    against `item.user.id`. A lane id in there quietly contaminates a set of
 *    user ids.
 *  - **Not `MuteWord`.** That model feeds a text matcher; this is an id equality.
 *  - **Not `UserSettings`.** That document is projected on EVERY feed request. An
 *    unbounded per-reader array would grow the hottest document on the read path.
 *
 * `laneOwnerOxyUserId` is denormalized so the settings screen can group a
 * reader's mutes by publisher without a join.
 *
 * `autoIndex`/`autoCreate` are OFF in production, so the indexes declared below
 * are created by migration `0022-lane-indexes`, not on model load.
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface ILaneMute extends Document {
  viewerOxyUserId: string;
  laneId: string;
  /** Denormalized: groups the settings screen by publisher, with no join. */
  laneOwnerOxyUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

const LaneMuteSchema = new Schema<ILaneMute>(
  {
    viewerOxyUserId: { type: String, required: true },
    laneId: { type: String, required: true },
    laneOwnerOxyUserId: { type: String, required: true },
  },
  { timestamps: true },
);

/** One row per (reader, lane) — the idempotency of `POST /lanes/:id/mute`. */
LaneMuteSchema.index({ viewerOxyUserId: 1, laneId: 1 }, { unique: true });
/** The reader's own list, newest first — the settings screen and the feed load. */
LaneMuteSchema.index({ viewerOxyUserId: 1, createdAt: -1 });

export const LaneMute = mongoose.model<ILaneMute>('LaneMute', LaneMuteSchema);
export default LaneMute;
