/**
 * Channel — a shared, multi-user DESTINATION people follow without following its
 * authors. See `@mention/shared-types`'s `channel.ts` for the product rules; this
 * file holds only what storage has to know.
 *
 * `handle` is unique GLOBALLY, not per owner: a channel has its own `/c/<handle>`
 * URL and hangs off nobody's profile. `handleLower` is the canonical identity the
 * unique index is built on, derived by the model hook from
 * `normalizeChannelHandle` so no route, script or test can arrive at a second
 * spelling and quietly defeat the constraint.
 *
 * The three denormalized counters (`followerCount`, `memberCount`, `postCount`)
 * are here — unlike `Lane`, which deliberately has none — because a channel
 * directory ranks by follower count and cannot aggregate per row, and because
 * every one of them has a single writer that already owns the transition. They are
 * maintained with `$inc` on the write that causes the change, never recomputed on
 * read.
 *
 * `autoIndex`/`autoCreate` are OFF in production, so the indexes declared below
 * are created by migration `0024-channel-indexes`, not on model load.
 */

import mongoose, { Schema, Document } from 'mongoose';
import {
  CHANNEL_VISIBILITIES,
  CHANNEL_HANDLE_MAX_LENGTH,
  MAX_CHANNEL_DESCRIPTION_LENGTH,
  MAX_CHANNEL_TITLE_LENGTH,
  normalizeChannelHandle,
  type ChannelVisibility,
} from '@mention/shared-types';

export interface IChannel extends Document {
  handle: string;
  /** Canonical identity — what the unique index is built on. Derived, never supplied. */
  handleLower: string;
  title: string;
  description?: string;
  /** A bare Oxy file id. Never a URL: media resolution is the SDK's chokepoint. */
  avatar?: string;
  /** A bare Oxy file id. Never a URL: media resolution is the SDK's chokepoint. */
  banner?: string;
  ownerOxyUserId: string;
  visibility: ChannelVisibility;
  /**
   * Whether a channel post also names the person who wrote it. `false` is the
   * default and means the post is anonymous behind the channel — enforced in the
   * DTO (`PostHydrationService`), not in the renderer.
   */
  signPosts: boolean;
  followerCount: number;
  memberCount: number;
  postCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const ChannelSchema = new Schema<IChannel>(
  {
    handle: { type: String, required: true, trim: true, maxlength: CHANNEL_HANDLE_MAX_LENGTH },
    handleLower: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: MAX_CHANNEL_TITLE_LENGTH },
    description: { type: String, trim: true, maxlength: MAX_CHANNEL_DESCRIPTION_LENGTH },
    avatar: { type: String },
    banner: { type: String },
    ownerOxyUserId: { type: String, required: true },
    visibility: {
      type: String,
      enum: [...CHANNEL_VISIBILITIES],
      default: 'public',
    },
    signPosts: { type: Boolean, default: false },
    followerCount: { type: Number, default: 0 },
    memberCount: { type: Number, default: 0 },
    postCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

/**
 * `handleLower` is derived, never supplied — one definition of what a handle IS.
 * A handle the canonicalizer rejects leaves `handleLower` unset, which fails the
 * `required` validator: an illegal handle is refused by the model rather than
 * stored in a form no reader can find.
 */
ChannelSchema.pre('validate', function () {
  if (typeof this.handle === 'string') {
    const canonical = normalizeChannelHandle(this.handle);
    if (canonical) {
      this.handle = canonical;
      this.handleLower = canonical;
    }
  }
});

/** The channel's global identity, and the `/c/<handle>` lookup. */
ChannelSchema.index({ handleLower: 1 }, { unique: true });
/** An owner's own channels, newest first — the management screen. */
ChannelSchema.index({ ownerOxyUserId: 1, createdAt: -1 });
/** The directory's keyset: most-followed first, `_id` breaking the tie. */
ChannelSchema.index({ visibility: 1, followerCount: -1, _id: -1 });

export const Channel = mongoose.model<IChannel>('Channel', ChannelSchema);
export default Channel;
