import type { HydratedPostSummary } from '@mention/shared-types';

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
