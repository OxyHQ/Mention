/**
 * ChannelMember — who may PUBLISH to a channel.
 *
 * Membership and following are different concepts and stay different rows: a
 * member need not follow the channel, and a follower is never a member. See
 * `ChannelFollow` for the other half.
 *
 * **Its own collection, not an array embedded on `Channel`.** `AccountList` embeds
 * `memberOxyUserIds` because that is a list of ids with no state of its own. A
 * channel member carries a role, an invitation state and its timestamps, and the
 * publish-time authorization check is an INDEXED POINT LOOKUP on the hot write
 * path — an embedded array would mean loading the whole channel document on every
 * post, and would eventually meet the BSON document limit.
 *
 * The status vocabulary is copied verbatim from `PostAuthorshipEntry` on
 * collaborative posts (`accepted | pending | declined | removed`), which is the
 * same state machine and is already proven in production.
 *
 * `autoIndex`/`autoCreate` are OFF in production, so the indexes declared below
 * are created by migration `0024-channel-indexes`, not on model load.
 */

import mongoose, { Schema, Document } from 'mongoose';
import {
  CHANNEL_MEMBER_ROLES,
  CHANNEL_MEMBER_STATUSES,
  type ChannelMemberRole,
  type ChannelMemberStatus,
} from '@mention/shared-types';

export interface IChannelMember extends Document {
  channelId: string;
  oxyUserId: string;
  role: ChannelMemberRole;
  status: ChannelMemberStatus;
  /** Who sent the invite. Absent on the owner's own founding row. */
  invitedByOxyUserId?: string;
  invitedAt?: Date;
  respondedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ChannelMemberSchema = new Schema<IChannelMember>(
  {
    channelId: { type: String, required: true },
    oxyUserId: { type: String, required: true },
    role: {
      type: String,
      enum: [...CHANNEL_MEMBER_ROLES],
      default: 'publisher',
    },
    status: {
      type: String,
      enum: [...CHANNEL_MEMBER_STATUSES],
      default: 'pending',
    },
    invitedByOxyUserId: { type: String },
    invitedAt: { type: Date },
    respondedAt: { type: Date },
  },
  { timestamps: true },
);

/**
 * One membership row per (channel, user). This constraint IS the 409 on a repeat
 * invite: the pre-check that looks for an existing row is not a lock.
 */
ChannelMemberSchema.index({ channelId: 1, oxyUserId: 1 }, { unique: true });
/** The channel's own member list, and the member-count aggregate. */
ChannelMemberSchema.index({ channelId: 1, status: 1 });
/** "Which channels may I publish to" — the composer's destination picker. */
ChannelMemberSchema.index({ oxyUserId: 1, status: 1 });

export const ChannelMember = mongoose.model<IChannelMember>('ChannelMember', ChannelMemberSchema);
export default ChannelMember;
