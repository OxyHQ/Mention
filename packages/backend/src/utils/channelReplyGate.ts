/**
 * A channel's post takes NO replies, from anybody, ever.
 *
 * A channel is a newspaper, not a group chat: readers like, save, quote and boost,
 * and the conversation happens outside. This module is the ONE definition of that
 * rule, and every path that can create a reply asks it.
 *
 * **The rule is keyed on the post's AUTHOR, not on a field of the post.** A
 * channel is an Oxy account (`kind: 'channel'`) and authors its own posts, so
 * `post.oxyUserId` IS the channel and there is no local marker on the row to read
 * — the question "is this a channel post" is the question "is this author a
 * channel account".
 *
 * FOUR properties are load-bearing, and each one is a mistake somebody would
 * otherwise make while "tidying up":
 *
 *  1. **It reads the author's account kind, NEVER `replyPermission`.**
 *     `replyPermission` is mutable through `PATCH /posts/:id/settings`, so a
 *     server that leaned on it could have the refusal switched off by the post's
 *     own author. Channel posts are still PERSISTED with
 *     `replyPermission: ['nobody']`, but only as defence in depth and so the
 *     existing client hides the reply button with the mechanism it already has —
 *     the 403 does not depend on that field, and `updatePostSettings` refuses to
 *     change it on a channel post anyway.
 *
 *  2. **There is no exception for the writer, and none for the channel's owner.**
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
 *     one. Those callers use {@link postIsAuthoredByChannel} /
 *     {@link parentIsChannelPost} and log at debug.
 *
 *  4. **An author that will not resolve is NOT treated as a channel.** The kind
 *     comes from Oxy, so an identity outage makes it unknowable — and the two
 *     failure directions are not comparable. Answering "channel" on an unresolved
 *     author refuses replies to EVERY post on the site for the duration of the
 *     outage; answering "not a channel" admits replies to channel posts for the
 *     same window, which is a handful of rows that can be deleted afterwards. So
 *     unknown reads as not-a-channel, deliberately.
 *
 * The account lookup itself lives in `services/publishAsAccount` — the one place
 * that knows what a channel account IS — and goes through the Redis-cached
 * identity path post hydration already fills for every author it renders, so on
 * the reply hot path this gate costs a batched Redis read rather than an Oxy
 * round trip.
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { isChannelAccount } from '../services/publishAsAccount';

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
 * Whether this post was authored BY a channel account — for the callers that
 * already hold the post document.
 */
export async function postIsAuthoredByChannel(
  post: { oxyUserId?: string | null } | null | undefined,
): Promise<boolean> {
  return isChannelAccount(post?.oxyUserId ? String(post.oxyUserId) : undefined);
}

/**
 * Whether the post with this id was authored by a channel — ONE indexed
 * projection lookup plus the cached kind, for the callers that hold only an id.
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
  const parent = await Post.findById(parentPostId).select('oxyUserId').lean<{
    oxyUserId?: string;
  } | null>();
  return postIsAuthoredByChannel(parent);
}

/**
 * Throw {@link ChannelReplyError} when the parent was authored by a channel.
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
