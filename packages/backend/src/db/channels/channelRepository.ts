/**
 * Writes to `channels` that carry an invariant no call site may re-spell.
 *
 * Three of them, and each was a Mongo mechanism with no Postgres counterpart:
 *
 *  1. **`handle_lower` is DERIVED.** It is what `channels_handle_lower_key` is
 *     built on, and Mongo derived it in a `pre('validate')` hook. That hook is
 *     gone, so the derivation lives here — see `schema/channels.ts`, which names
 *     this module as where it went. A handle the canonicalizer rejects is
 *     REFUSED rather than stored under a spelling no reader can find, which is
 *     exactly what the hook's `required` validator did.
 *  2. **A channel and its owner's membership row are ONE write.** Mongo issued
 *     two, and an interruption between them left a channel its own owner could
 *     not publish to and could not repair: `canPublishToChannel` answers from
 *     the membership row alone, on purpose, so there is no "or the owner" branch
 *     to fall back on. One transaction removes the window.
 *  3. **Deleting a channel RELEASES its posts before the row goes.** In Mongo
 *     that ordering was a convention the route documented at length. Here it is
 *     load-bearing in a harder way: `posts.channel_id` is `ON DELETE CASCADE`,
 *     so a `delete from channels` that is not preceded by the release DESTROYS
 *     every post ever published to the channel — including posts written by
 *     other publishers. One transaction, with the release first.
 */

import { and, eq } from 'drizzle-orm';
import { normalizeChannelHandle } from '@mention/shared-types';
import { getDb } from '../postgres';
import { channelMembers, channels, lanes } from '../schema/channels';
import { posts } from '../schema/posts';

/** A channel row exactly as the routes read it back. */
export type ChannelRow = typeof channels.$inferSelect;

/**
 * A handle `normalizeChannelHandle` refuses, reaching a write.
 *
 * The routes validate the handle themselves so they can answer 400 with a
 * message naming the rule. This is the backstop underneath that — the direct
 * replacement for the Mongoose `required` validator that fired when the hook
 * left `handleLower` unset, and the reason a future writer cannot store a
 * channel under a spelling `GET /c/<handle>` will never look for.
 */
export class ChannelHandleError extends Error {
  constructor(handle: string) {
    super(`"${handle}" is not a legal channel handle`);
    this.name = 'ChannelHandleError';
  }
}

/** The profile fields a channel's owner may set. */
export interface ChannelProfileInput {
  title: string;
  description?: string;
  /** A bare Oxy file id. Never a URL — media resolution is the SDK's chokepoint. */
  avatar?: string;
  /** A bare Oxy file id. Never a URL — media resolution is the SDK's chokepoint. */
  banner?: string;
  signPosts: boolean;
}

/**
 * Create a channel and the owner's own `accepted` membership row, atomically.
 *
 * `member_count` starts at 1 because that row exists from the first instant —
 * the counter and the population it counts are written together, so they cannot
 * start out disagreeing.
 *
 * @throws {ChannelHandleError} When `handle` is not a legal channel handle.
 */
export async function insertChannelWithOwner(
  handle: string,
  ownerOxyUserId: string,
  profile: ChannelProfileInput,
): Promise<ChannelRow> {
  const canonical = normalizeChannelHandle(handle);
  if (!canonical) throw new ChannelHandleError(handle);

  return getDb().transaction(async (tx) => {
    const [channel] = await tx
      .insert(channels)
      .values({
        // The canonical spelling is BOTH columns: `handle` is what a page
        // renders and `handle_lower` is what the unique index is built on, and
        // Mongo's hook wrote the same value to each. Storing a different
        // `handle` would let two channels differ only by case in the display.
        handle: canonical,
        handleLower: canonical,
        title: profile.title,
        description: profile.description,
        avatar: profile.avatar,
        banner: profile.banner,
        ownerOxyUserId,
        visibility: 'public',
        signPosts: profile.signPosts,
        memberCount: 1,
      })
      .returning();

    await tx.insert(channelMembers).values({
      channelId: channel.id,
      oxyUserId: ownerOxyUserId,
      role: 'owner',
      status: 'accepted',
      respondedAt: new Date(),
    });

    return channel;
  });
}

/**
 * Update a channel's profile. A `handle` in the patch moves `handle_lower` with
 * it — the pair can never be written apart.
 *
 * @returns The updated row, or `null` when no channel has that id.
 * @throws {ChannelHandleError} When `patch.handle` is present and illegal.
 */
export async function updateChannelProfile(
  channelId: string,
  patch: Partial<ChannelProfileInput> & { handle?: string },
): Promise<ChannelRow | null> {
  let canonical: string | undefined;
  if (patch.handle !== undefined) {
    canonical = normalizeChannelHandle(patch.handle) ?? undefined;
    if (!canonical) throw new ChannelHandleError(patch.handle);
  }

  const [row] = await getDb()
    .update(channels)
    .set({
      ...(canonical === undefined ? {} : { handle: canonical, handleLower: canonical }),
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.avatar === undefined ? {} : { avatar: patch.avatar }),
      ...(patch.banner === undefined ? {} : { banner: patch.banner }),
      ...(patch.signPosts === undefined ? {} : { signPosts: patch.signPosts }),
    })
    .where(eq(channels.id, channelId))
    .returning();
  return row ?? null;
}

/**
 * Delete a channel, everything that hangs off it, and nothing else — in ONE
 * transaction.
 *
 * The FIRST statement is the whole reason this is not a one-line delete, and it
 * is more load-bearing here than it was in Mongo:
 *
 *  - `posts.channel_id` is `ON DELETE CASCADE`, so releasing the posts is what
 *    stands between deleting a channel and deleting every post ever published
 *    to it. `lane_id` goes with it because the lane it names is deleted below.
 *  - The channel's own lanes then go; `lane_mutes.lane_id` is
 *    `ON DELETE CASCADE`, so the readers' mutes of them go too. A lane whose
 *    publisher no longer exists can never be reached or managed.
 *  - `channel_members` and `channel_follows` are `ON DELETE CASCADE` on
 *    `channel_id`, so the channel row itself takes them.
 *
 * One transaction, so unlike the Mongo version there is no partial state to
 * fail into: either the channel is gone and its posts belong to their authors
 * again, or nothing happened.
 */
export async function deleteChannelCascade(channelId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx
      .update(posts)
      .set({ channelId: null, laneId: null })
      .where(eq(posts.channelId, channelId));

    await tx
      .delete(lanes)
      .where(and(eq(lanes.ownerType, 'channel'), eq(lanes.ownerId, channelId)));

    await tx.delete(channels).where(eq(channels.id, channelId));
  });
}
