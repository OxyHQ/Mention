/**
 * Lane — a publisher's own named carriageway through their output.
 *
 * A lane belongs to ONE publisher, and a publisher is a user OR a channel
 * (`ownerType` + `ownerId`). Channels curate their own page exactly the way a
 * user curates a profile, so the polymorphic owner is here from the first row:
 * bolting it on later would mean migrating every lane already written.
 *
 * Deliberately ABSENT, both times for the same reason — the cheapest correct
 * thing is no field at all:
 *
 *  - **No `slug`.** The tab routes by id. A slug would be either immutable
 *    (stale the moment somebody renames a lane) or regenerated (breaking the
 *    URL), and it would add a uniqueness constraint, a rename decision, and a
 *    whole class of collisions to carry forever.
 *  - **No denormalized `postCount`.** It would have to be maintained on post
 *    create, on a lane move, on post delete and in every admin purge, and a
 *    wrong counter is worse than none. The management screen aggregates instead,
 *    served by `post_lane_chrono_v1`.
 *
 * `autoIndex`/`autoCreate` are OFF in production, so the indexes declared below
 * are created by migration `0022-lane-indexes`, not on model load.
 */

import mongoose, { Schema, Document } from 'mongoose';
import {
  LANE_DISPLAY_MODES,
  LANE_OWNER_TYPES,
  MAX_LANE_NAME_LENGTH,
  type LaneDisplayMode,
  type LaneOwnerType,
} from '@mention/shared-types';

export interface ILane extends Document {
  ownerType: LaneOwnerType;
  /** The publisher's id: an `oxyUserId` for `user`, a channel id for `channel`. */
  ownerId: string;
  name: string;
  /** Case/whitespace-normalized identity, so uniqueness is per publisher and case-insensitive. */
  nameLower: string;
  displayMode: LaneDisplayMode;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The normalized identity of a lane name: trimmed, inner whitespace collapsed,
 * lowercased. Shared by the model hook and by every reader that has to ask
 * "does this publisher already have this lane" without a second spelling of the
 * rule.
 */
export function normalizeLaneName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

const LaneSchema = new Schema<ILane>(
  {
    ownerType: {
      type: String,
      enum: LANE_OWNER_TYPES as LaneOwnerType[],
      required: true,
    },
    ownerId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: MAX_LANE_NAME_LENGTH },
    nameLower: { type: String, required: true },
    displayMode: {
      type: String,
      enum: LANE_DISPLAY_MODES as LaneDisplayMode[],
      default: 'mixed',
    },
  },
  { timestamps: true },
);

/**
 * `nameLower` is derived, never supplied. Keeping it in a hook means a route, a
 * script and a test cannot each arrive at a different normalization and quietly
 * defeat the unique index below.
 */
LaneSchema.pre('validate', function () {
  if (typeof this.name === 'string') {
    this.nameLower = normalizeLaneName(this.name);
  }
});

/** The publisher's own list, newest first — the management screen. */
LaneSchema.index({ ownerType: 1, ownerId: 1, createdAt: -1 });
/** One name per publisher. The 409 on create is this constraint, not a count. */
LaneSchema.index({ ownerType: 1, ownerId: 1, nameLower: 1 }, { unique: true });
/** The exclusion lookup, which runs on EVERY profile / channel feed request. */
LaneSchema.index({ ownerType: 1, ownerId: 1, displayMode: 1 });

export const Lane = mongoose.model<ILane>('Lane', LaneSchema);
export default Lane;
