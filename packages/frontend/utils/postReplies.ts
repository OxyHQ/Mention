import type { HydratedPostSummary, ReplyPermission } from '@mention/shared-types';

/**
 * Whether a post can be replied to at all — the ONE definition both the feed
 * row's action bar and the post detail's pinned composer read.
 *
 * The answer comes from the post's own permissions, and from nothing else. A
 * channel post still takes no replies, but a channel is an Oxy ACCOUNT now, so
 * there is no channel field on the DTO to key off: the server decides at write
 * time and says so in `permissions.canReply` and `metadata.replyPermission`.
 * Re-deriving the refusal from the author's identity would be a second, weaker
 * copy of a rule the server already stated.
 *
 * `permissions.canReply` is the viewer-resolved verdict (it accounts for
 * `followers`/`mentioned` audiences the client cannot evaluate), so it wins;
 * `replyPermission` is the fallback for the surfaces whose DTO carries the
 * post's setting but no viewer resolution.
 *
 * Derived from the POST, never handed down as a prop. `PostItem`'s `React.memo`
 * comparator enumerates every prop, so a "can reply" prop missed there would
 * leave a recycled FlashList row offering a reply affordance the previous row's
 * post allowed — the same class of bug the lane chip is read off the DTO to
 * avoid.
 */
export function postAcceptsReplies(post: HydratedPostSummary | null | undefined): boolean {
  if (!post) return false;
  if (post.permissions?.canReply === false) return false;
  return post.metadata?.replyPermission?.includes('nobody') !== true;
}

/**
 * The reply restriction worth TELLING A READER ABOUT — which is a narrower
 * question than {@link postAcceptsReplies}, and the two must not be conflated.
 *
 * That predicate answers "can this be replied to", where every refusal is
 * interchangeable: an affordance that would fail is hidden either way. This one
 * answers "did the author DECIDE this", and only `replyPermission` records a
 * decision. A viewer-resolved `canReply: false` can mean the viewer simply is
 * not in the audience, which is not a fact about the post to announce.
 */
export function reportableReplyPermission(
  post: HydratedPostSummary | null | undefined,
): ReplyPermission[] | undefined {
  return post?.metadata?.replyPermission;
}
