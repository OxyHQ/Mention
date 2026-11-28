// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** Whether one viewer may read one post: ownership, recipients and the channel-authority question. */
import { PostVisibility, type PostAuthorshipEntry } from '@mention/shared-types';
import { getViewerEntry } from '../../../utils/postAuthorship';
import type { RawPost, ViewerContext } from './types';

/**
 * Does this post's readability turn on whether the viewer OWNS it?
 *
 * The five gates below — unpublished, private or direct, followers-only to a
 * non-follower, an author the viewer is restricted by, an author behind a
 * private profile — are exactly the states {@link viewerOwnsPost} overrides.
 * `false` means every one of them passes on its own terms and the post is
 * readable whoever is asking; `true` means ownership is the whole question.
 *
 * Split out of {@link PostHydrationService.canViewerReadPost} (whose verdict is
 * unchanged — this is the same five conditions with the repeated
 * `&& !viewerOwnsPost` factored out) so that {@link resolveCurrentChannelAuthority}
 * can ask "could proving current authority change this answer?" without
 * restating any of them. A second, hand-written copy of the gate conditions
 * would decide when to pay for the proof, and drift from the gate that consumes
 * it — the direction that drifts silently is a post nobody can read.
 */
function ownershipDecidesReadability(
  post: RawPost,
  authorId: string,
  viewerContext: ViewerContext,
): boolean {
  if ((post.status ?? 'published') !== 'published') return true;

  const visibility = (post.visibility ?? PostVisibility.PUBLIC) as PostVisibility;
  if (visibility === PostVisibility.PRIVATE || visibility === PostVisibility.DIRECT) return true;

  const viewerFollowsAuthor =
    Boolean(viewerContext.viewerId) && viewerContext.follows.has(authorId);
  if (visibility === PostVisibility.FOLLOWERS_ONLY && !viewerFollowsAuthor) return true;

  if (viewerContext.restrictedIds.has(authorId)) return true;

  // A private / followers-only PROFILE, which is a separate setting from the
  // post's own visibility. A follower passes; everyone else needs ownership.
  if (viewerContext.privateProfileIds.has(authorId) && !viewerFollowsAuthor) return true;

  return false;
}

/**
 * May this viewer read a post that one of the gates above holds shut?
 *
 * Pending collaborators may PREVIEW the post they were invited to (so the
 * collab-invite UI can render the actual content before they accept), alongside
 * the owner and accepted collaborators.
 *
 * The last clause is the CHANNEL case, and it exists because the id comparison
 * answers "no" for every human on a channel's post: a channel AUTHORS its own
 * posts, and no session can ever have a channel as its subject. Without it a
 * withheld channel post is readable by nobody at all — not a narrow gap, a black
 * hole, and measured as one.
 *
 * **`writtenByOxyUserId` is deliberately NOT read here, and that is the whole
 * point of this function's shape.** The stored writer used to be admitted
 * through `canManagePostWithoutLookup`, off a column already in hand and with no
 * lookup. But that column records who wrote the post, is written once at
 * creation and never again — not when somebody else rewrites the post, and not
 * when its writer leaves the channel. Treating it as authority let a removed
 * member keep reading the channel's embargoed queue, and keep reading the
 * DESK'S LATER EDITS to it, for as long as they held the post id. Historical
 * authorship is not current authority, so the proof has to be current:
 * `operatedAccountIds`, resolved per request from Oxy's account graph.
 *
 * It is `resolveCurrentChannelAuthority` that makes that affordable, and this
 * function is meaningless without it — the two have to move together.
 *
 * **The WRITE side has since been closed to match, and there is no longer a
 * clause granting it.** `postManagementRefusal` used to take a free path on
 * `canManagePostWithoutLookup` unless a caller opted out of it, so a removed
 * member could still destroy or rewrite the queued post this gate refuses to
 * show them. All seven management routes now prove current authority, with no
 * per-route opt-out to forget. What remains is the DTO's `viewerState.isOwner`,
 * which still reads the stored writer and is now deliberately WIDER than any
 * route will honour — the argument for that residue is on
 * `postManagementRefusal`, and it is a stale menu, never a stale capability.
 *
 * It takes no post, and that absence is the change: every remaining answer comes
 * from the viewer's identity, the authorship rows and the account graph. Nothing
 * a post row can carry decides this any more.
 */
export function viewerOwnsPost(
  authorId: string,
  authorship: PostAuthorshipEntry[],
  viewerContext: ViewerContext,
): boolean {
  const viewerEntry = getViewerEntry(authorship, viewerContext.viewerId);
  return (
    viewerContext.viewerId === authorId ||
    (viewerEntry?.role === 'collaborator' &&
      (viewerEntry.status === 'accepted' || viewerEntry.status === 'pending')) ||
    (Boolean(viewerContext.viewerId) && viewerContext.operatedAccountIds.has(authorId))
  );
}

/**
 * Is the viewer one of the people this published private mention is addressed
 * to?
 *
 * The second — and only other — way into a `direct` post besides
 * {@link viewerOwnsPost}, and it is a RESOURCE GRANT, not merely an audience
 * pass: the author named this person, so Oxy's private-author rule must not
 * refuse them for not following. It grants nothing on any other visibility, and
 * nothing on an unpublished post, so it can never open a draft or a scheduled
 * post to the people it will be sent to.
 */
export function viewerIsRecipient(post: RawPost, viewerContext: ViewerContext): boolean {
  const viewerId = viewerContext.viewerId;
  return (
    Boolean(viewerId) &&
    post.visibility === PostVisibility.DIRECT &&
    (post.status ?? 'published') === 'published' &&
    Array.isArray(post.recipients) &&
    post.recipients.includes(viewerId)
  );
}

/**
 * Is this a post where proving CURRENT authority over the authoring account
 * could change the verdict — the only case worth an Oxy round trip for?
 *
 * Three conditions, and each one removes a case that could never be decided by
 * the answer:
 *
 *  - `writtenByOxyUserId` is set. That column is written exactly when an ACCOUNT
 *    authored the post on a human's behalf, so an absent one means there is no
 *    account whose membership anybody could be a member of.
 *  - the viewer is not themselves the author. If they were, the id comparison in
 *    {@link viewerOwnsPost} has already admitted them for free.
 *  - {@link ownershipDecidesReadability}. A published, public post from an
 *    unrestricted account is readable without any of this — which is every
 *    channel post on every feed, and why no feed pays for this.
 */
export function mayNeedCurrentChannelAuthority(
  post: RawPost,
  viewerContext: ViewerContext,
): boolean {
  if (!post?.writtenByOxyUserId) return false;
  const authorId = post.oxyUserId ? String(post.oxyUserId) : '';
  if (!authorId || authorId === viewerContext.viewerId) return false;
  return ownershipDecidesReadability(post, authorId, viewerContext);
}

/**
 * May this viewer read this post at all?
 *
 * The single post-level ACL, applied to LOCAL and FEDERATED posts alike.
 * `mapApVisibility` stores a Note addressed to its author's followers as
 * `followers_only`, so a federated post is NOT public by definition and a
 * blanket bypass here served a remote author's private post to anybody who
 * asked for it by id. Hydration is used for globally-broadcast DTOs and for
 * nested quote/boost references fetched by id, so the gate lives here rather
 * than relying on every caller to pre-filter.
 *
 * Extracted from {@link buildPostSummary} (whose behaviour is unchanged) so
 * that {@link buildReplyParentAuthorMap} can ask the identical question about a
 * reply's PARENT. A reply's "Replying to @…" header names the parent's author,
 * which must not reveal the author — or the existence — of a post this viewer
 * would be refused. Answering that with a second, hand-rolled visibility check
 * is exactly how the two would drift apart; there is one gate and both call it.
 *
 * Two halves, and the split is what lets the cost of the second one be decided
 * before it is paid: {@link ownershipDecidesReadability} says whether the post
 * is withheld from this viewer at all, {@link viewerOwnsPost} says whether they
 * override it. `resolveCurrentChannelAuthority` asks the first of those, in
 * `buildViewerContext`, to decide whether the second is worth an Oxy round trip.
 */
export function canViewerReadPost(
  post: RawPost,
  authorId: string,
  authorship: PostAuthorshipEntry[],
  viewerContext: ViewerContext,
): boolean {
  if (!ownershipDecidesReadability(post, authorId, viewerContext)) return true;
  return (
    viewerOwnsPost(authorId, authorship, viewerContext) || viewerIsRecipient(post, viewerContext)
  );
}
