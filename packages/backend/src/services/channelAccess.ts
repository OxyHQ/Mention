/**
 * The ONE definition of what somebody may do with a channel.
 *
 * Every write path and every read path asks here, so "may publish" cannot come to
 * mean one thing in the post controller and another in the routes. Three
 * questions, deliberately separate because they have different answers:
 *
 *  - {@link canPublishToChannel} — is this an ACCEPTED member? The publish gate.
 *  - {@link canManageChannel}    — is this the owner? Profile, lanes, membership.
 *  - {@link canViewChannel}      — may this reader see the channel at all?
 *
 * `canViewChannel` looks trivial today because `visibility` has one value. It
 * exists anyway, and every read path calls it, so that adding a restricted level
 * later is widening this function rather than auditing every surface for the one
 * that forgot to ask.
 */

import mongoose from 'mongoose';
import { Channel, type IChannel } from '../models/Channel';
import { ChannelMember } from '../models/ChannelMember';
import { logger } from '../utils/logger';

/** A refusal carrying the status the HTTP layer should answer with. */
export class ChannelAccessError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ChannelAccessError';
    this.status = status;
  }
}

/** The channel fields an access decision needs, however the caller loaded it. */
export interface ChannelAccessSubject {
  _id: unknown;
  ownerOxyUserId: string;
  visibility: string;
}

/**
 * Whether this reader may see this channel.
 *
 * v1 is public-only, so the answer is yes for everybody — including anonymous
 * readers, which is why `viewerId` is optional. The SEAM is the point: a
 * restricted level would be a branch here and nowhere else.
 */
export function canViewChannel(
  channel: Pick<ChannelAccessSubject, 'visibility'>,
  _viewerId?: string,
): boolean {
  return channel.visibility === 'public';
}

/**
 * Whether this user manages the channel: its profile, its lanes, and who may
 * publish to it. Only the owner. A publisher publishes to a channel; they do not
 * define it.
 */
export function canManageChannel(
  channel: Pick<ChannelAccessSubject, 'ownerOxyUserId'>,
  viewerId: string | undefined,
): boolean {
  return Boolean(viewerId) && channel.ownerOxyUserId === viewerId;
}

/**
 * Whether this user may publish to this channel — an ACCEPTED `ChannelMember` row
 * and nothing else. The owner has one of their own, written when the channel is
 * created, so there is no "or the owner" branch here to drift from the row.
 *
 * ONE indexed point lookup on `{ channelId, oxyUserId }`, on the hot write path.
 */
export async function canPublishToChannel(
  channelId: string,
  oxyUserId: string | null | undefined,
): Promise<boolean> {
  if (!oxyUserId || !channelId) return false;
  if (!mongoose.Types.ObjectId.isValid(channelId)) return false;
  const member = await ChannelMember.exists({ channelId, oxyUserId, status: 'accepted' });
  return member != null;
}

/**
 * Resolve a channel for a WRITE and refuse unless this author may publish to it.
 *
 * Throws {@link ChannelAccessError}, never returns a partial answer:
 *  - a malformed or unknown channel id is a **404** — indistinguishable from a
 *    channel that exists and answers to somebody else, so this is no existence
 *    oracle;
 *  - a real channel the author is not an accepted member of is a **403**, because
 *    the channel is public and its existence is not a secret; what is refused is
 *    the publishing, and saying so is what lets an invited-but-not-yet-accepted
 *    member understand why their post bounced.
 *
 * Free when there is no channel: `channelId == null` returns `null` with no query,
 * which is the overwhelming majority of posts.
 */
export async function assertCanPublishToChannel(
  channelId: string | null | undefined,
  authorId: string | null | undefined,
): Promise<IChannel | null> {
  if (!channelId) return null;

  if (!authorId) {
    throw new ChannelAccessError(403, 'You cannot publish to a channel');
  }
  if (!mongoose.Types.ObjectId.isValid(channelId)) {
    throw new ChannelAccessError(404, 'Channel not found');
  }

  const channel = await Channel.findById(channelId);
  if (!channel) {
    throw new ChannelAccessError(404, 'Channel not found');
  }

  if (!(await canPublishToChannel(channelId, authorId))) {
    throw new ChannelAccessError(403, 'You are not a member of this channel');
  }

  return channel;
}

/**
 * Keep a channel's denormalized counters honest, with `$inc` on the write that
 * caused the change rather than a recount on read.
 *
 * Best-effort by design: a counter is a display number, and losing the increment
 * on a post that WAS published is a smaller harm than failing the publish over it.
 * A failure is logged at `warn` so a systematically drifting counter is visible
 * rather than merely wrong.
 */
export async function bumpChannelCounter(
  channelId: string,
  field: 'followerCount' | 'memberCount' | 'postCount',
  delta: number,
): Promise<void> {
  if (!channelId || !mongoose.Types.ObjectId.isValid(channelId) || delta === 0) return;
  try {
    await Channel.updateOne({ _id: channelId }, { $inc: { [field]: delta } });
  } catch (error) {
    logger.warn('[channelAccess] Failed to update channel counter', {
      channelId,
      field,
      delta,
      error,
    });
  }
}
