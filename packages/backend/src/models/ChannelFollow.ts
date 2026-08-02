/**
 * ChannelFollow — one reader following one channel.
 *
 * **Its own model, NOT `EntityFollow`,** and the reasons are concrete rather than
 * stylistic:
 *
 *  - A channel needs per-follower state that `EntityFollow`'s three-field schema
 *    cannot carry: `notify`, i.e. muting a channel without unfollowing it. That
 *    becomes mandatory the moment a channel notifies at all, which it does.
 *  - Inside `entity-follow.routes.ts` every behaviour is already a hand-wired
 *    `if (entityType === …)` branch, and that router's own comment warns that the
 *    generic surface is a trap.
 *  - That router has NO "followers of an entity" endpoint, and its comment says
 *    restoring one needs a per-entity-type visibility rule. A channel needs both a
 *    count and (later) a list.
 *  - The repo has precedent in both directions and chose a dedicated model for the
 *    closest analogue: a custom-feed subscription is a `FeedLike` row, and `feed`
 *    was REMOVED from `ENTITY_FOLLOW_TYPES`.
 *  - Member roles are impossible in `EntityFollow` regardless, so Channels needs a
 *    dedicated model anyway; the second one costs almost nothing and keeps
 *    "follows" and "may publish" as the separate concepts they are.
 *
 * `autoIndex`/`autoCreate` are OFF in production, so the indexes declared below
 * are created by migration `0024-channel-indexes`, not on model load.
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface IChannelFollow extends Document {
  channelId: string;
  oxyUserId: string;
  /**
   * Whether this follower wants to be notified about new posts. Default `true`:
   * following a channel in the Telegram sense IS subscribing to it, and a switch
   * that starts off would make the feature look broken.
   */
  notify: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ChannelFollowSchema = new Schema<IChannelFollow>(
  {
    channelId: { type: String, required: true },
    oxyUserId: { type: String, required: true },
    notify: { type: Boolean, default: true },
  },
  { timestamps: true },
);

/** One row per (reader, channel) — what makes following idempotent. */
ChannelFollowSchema.index({ oxyUserId: 1, channelId: 1 }, { unique: true });
/**
 * The reader's OWN list — `GET /channels/following`, newest follow first.
 *
 * Named and compound-with-`_id` on purpose: the route pages by keyset on
 * `{ createdAt: -1, _id: -1 }`, and without `_id` in the index the tiebreak
 * becomes a residual in-memory sort that a keyset cursor cannot rely on. The
 * unique index above cannot serve this — it orders by `channelId`, which bears no
 * relation to when the reader followed.
 *
 * NOTE: `autoIndex`/`autoCreate` are OFF in production — created by migration
 * `0025-channel-follow-user-index`, not on model load.
 */
ChannelFollowSchema.index(
  { oxyUserId: 1, createdAt: -1, _id: -1 },
  { name: 'channel_follow_by_user_v1' },
);
/**
 * The notification fan-out's keyset: the followers of ONE channel who want to be
 * notified, paged by `_id` so a large channel is walked rather than loaded.
 */
ChannelFollowSchema.index({ channelId: 1, notify: 1, _id: 1 });

export const ChannelFollow = mongoose.model<IChannelFollow>('ChannelFollow', ChannelFollowSchema);
export default ChannelFollow;
