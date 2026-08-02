/**
 * A channel post takes NO replies, from anybody, ever.
 *
 * A channel is a newspaper, not a group chat: readers like, save, quote and boost,
 * and the conversation happens outside. This module is the ONE definition of that
 * rule, and every path that can create a reply asks it.
 *
 * THREE properties are load-bearing, and each one is a mistake somebody would
 * otherwise make while "tidying up":
 *
 *  1. **It reads `channelId`, NEVER `replyPermission`.** `replyPermission` is
 *     mutable through `PATCH /posts/:id/settings`, so a server that leaned on it
 *     could have the refusal switched off by the post's own author. Channel posts
 *     are still PERSISTED with `replyPermission: ['nobody']`, but only as defence
 *     in depth and so the existing client hides the reply button with the
 *     mechanism it already has — the 403 does not depend on that field, and
 *     `updatePostSettings` refuses to change it on a channel post anyway.
 *
 *  2. **There is no exception for the author, and none for the channel's owner.**
 *     The reply-permission block in `feed.controller` contains an unconditional
 *     escape (`if (parentAuthorId === currentUserId) { /* Allow *\/ }`) that lets an
 *     author reply to their own post even under `replyPermission: ['nobody']`.
 *     This gate therefore sits ABOVE that whole block — which is also skipped
 *     entirely when the permissions include `'anyone'`, so a gate placed inside it
 *     would not run at all on a normal post.
 *
 *  3. **The federated paths DROP, they do not throw and do not answer 4xx.** A
 *     throw inside the BullMQ inbox worker fails the job into retry forever, and a
 *     4xx from an inbox POST makes Mastodon stop delivering to this instance
 *     PERMANENTLY — killing every follow, accept, like and reply, not just this
 *     one. Those callers use {@link isChannelPost} /
 *     {@link parentIsChannelPost} and log at debug.
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';

/** A refusal carrying the status the HTTP layer should answer with. */
export class ChannelReplyError extends Error {
  readonly status: number;

  constructor(message = 'This post does not accept replies') {
    super(message);
    this.name = 'ChannelReplyError';
    this.status = 403;
  }
}

/**
 * The ONE predicate: does this post belong to a channel?
 *
 * Deliberately structural (`typeof === 'string'` on a non-empty value) so a stored
 * `null`, an absent field and an empty string all read the same — no caller has to
 * remember which of those storage might hold.
 */
export function isChannelPost(post: { channelId?: unknown } | null | undefined): boolean {
  return typeof post?.channelId === 'string' && post.channelId.length > 0;
}

/**
 * Whether the post with this id belongs to a channel — ONE indexed projection
 * lookup, for the callers that hold only an id.
 *
 * A missing or malformed id answers `false`: "no parent" is not "a channel
 * parent", and the caller's own not-found handling is what deals with the former.
 * A database error propagates rather than being swallowed — on the HTTP paths it
 * becomes a 500, and on the BullMQ path it retries, which are both the right
 * answers for a genuine outage. What must never propagate is the CHANNEL verdict
 * itself on a federated path; see the module docstring.
 */
export async function parentIsChannelPost(
  parentPostId: string | null | undefined,
): Promise<boolean> {
  if (!parentPostId || !mongoose.Types.ObjectId.isValid(parentPostId)) return false;
  const parent = await Post.findById(parentPostId).select('channelId').lean<{
    channelId?: string;
  } | null>();
  return isChannelPost(parent);
}

/**
 * Throw {@link ChannelReplyError} when the parent belongs to a channel.
 *
 * For the two NATIVE reply paths (`feed.controller.createReply` and `POST /posts`
 * carrying `parentPostId` / `in_reply_to_status_id`), which answer HTTP directly
 * and so may refuse loudly. Federated paths must NOT use this — see the module
 * docstring for what a throw or a 4xx costs there.
 */
export async function assertParentAcceptsReplies(
  parentPostId: string | null | undefined,
): Promise<void> {
  if (await parentIsChannelPost(parentPostId)) {
    throw new ChannelReplyError();
  }
}
