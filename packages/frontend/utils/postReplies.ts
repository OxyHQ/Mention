import type { HydratedPostSummary, ReplyPermission } from '@mention/shared-types';

/**
 * Whether a post can be replied to at all — the ONE definition both the feed
 * row's action bar and the post detail's pinned composer read.
 *
 * Two refusals, and they are refusals for different reasons:
 *
 *  - **A channel post takes no replies, structurally.** A channel is a newspaper:
 *    read, like, save, quote, boost. The server enforces this off the post's
 *    `channelId` at four sites and never off `replyPermission`, precisely because
 *    a later settings write could flip that field — so the client asks the same
 *    question the same way.
 *  - **`nobody`** is the author's own choice, and `PostDetailStats` already reads
 *    it exactly like this.
 *
 * Derived from the POST, never handed down as a prop. `PostItem`'s `React.memo`
 * comparator enumerates every prop, so a "can reply" prop missed there would
 * leave a recycled FlashList row offering a reply affordance the previous row's
 * post allowed — the same class of bug the lane chip is read off the DTO to
 * avoid.
 */
export function postAcceptsReplies(post: HydratedPostSummary | null | undefined): boolean {
  if (!post) return false;
  if (post.channel) return false;
  return post.metadata?.replyPermission?.includes('nobody') !== true;
}

/**
 * The reply restriction worth TELLING A READER ABOUT — which is a narrower
 * question than {@link postAcceptsReplies}, and the two must not be conflated.
 *
 * That predicate answers "can this be replied to", where the two refusals are
 * interchangeable: an affordance that would fail is hidden either way. This one
 * answers "did somebody DECIDE this", where they are not interchangeable at all.
 * A channel takes no replies the way a newspaper takes no replies — it is what a
 * channel IS, not a switch anybody flipped — so announcing it invites the reader
 * to wonder who turned replies off, and the honest answer is nobody. A post
 * whose author chose `nobody` is the opposite case: that IS a decision, and the
 * reader learning it from the post beats learning it from a rejected reply.
 *
 * Hence a channel post reports NOTHING rather than reporting `['nobody']`. The
 * server persists that permission on a channel post as defence in depth, so it
 * is present on the DTO and would otherwise be read as the author's choice by a
 * caller that only looked at `metadata`.
 */
export function reportableReplyPermission(
  post: HydratedPostSummary | null | undefined,
): ReplyPermission[] | undefined {
  if (!post || post.channel) return undefined;
  return post.metadata?.replyPermission;
}
