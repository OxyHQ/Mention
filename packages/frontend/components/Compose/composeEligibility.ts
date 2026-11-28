// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { AccountNode } from '@oxy.so/core';
import type { PostUser } from '@mention/shared-types';

/** The community a post is written in, as the composer holds it. */
export type ComposeCommunity = Pick<PostUser, 'id' | 'username'>;

export interface ComposeEligibilityInput {
  /** Supervision has resolved and this author is not supervised. */
  unsupervised: boolean;
  /** Set when the composer answers a post (a reply takes its parent's audience, community and author). */
  replyToPostId: string | undefined;
  isEditMode: boolean;
  /** Whether the post is a private mention (see `audienceEligible`). */
  isDirect: boolean;
  /** Server-decided: the stored post under edit is still a solo one. */
  editCollabEligible: boolean;
  /** Number of continuation boxes below the main one. */
  threadItemCount: number;
  postingMode: 'thread' | 'beast';
  /** Whether the viewer may use communities at all. */
  communitiesPreview: boolean;
  /** The account the author chose to publish as, whether or not that choice will be honoured. */
  publishAs: AccountNode | null;
  /** The community the author chose, whether or not that choice will be honoured. */
  community: ComposeCommunity | null;
}

export interface ComposeEligibility {
  /**
   * Whether this post can name collaborators at all. A reply and a thread are
   * authored solo, and an edit only qualifies while the stored post is still a
   * solo one (`editCollabEligible`, server-decided). Gates BOTH the people icon
   * in the attachment row and the picker it opens, so the icon can never open a
   * panel that will not render.
   */
  collaboratorsEligible: boolean;
  /**
   * Whether any post written here can be put on a lane at all.
   *
   * A reply cannot carry one — the server refuses it (400) and
   * `CreateReplyRequest` drops what it does not name, so offering the choice
   * would end in a 201 and a silently discarded lane. An edit cannot either: the
   * edit payload is an `UpdatePostRequest` and moving a post between lanes is a
   * separate write with no edit window (`PATCH /posts/:id/lane`), reached from
   * the post's own ⋯ menu. Both are hidden rather than disabled: there is
   * nothing the author could do here to make either work.
   */
  laneEligible: boolean;
  /**
   * Whether a CONTINUATION box may carry its own lane, answered per posting mode
   * — the same shape as the account predicates, and for the same reason.
   *
   * `POST /posts/thread` reads `laneId` off each entry, but honors it on a BEAST
   * entry (an independent top-level post) and on a THREAD's root only: a
   * continuation is created as a reply, and the controller refuses a lane on one
   * with a 400 that fails the WHOLE batch before anything is written. So the
   * first box keeps the control in both modes — it is the root either way — and
   * the rest get it only in beast mode.
   */
  threadLaneEligible: boolean;
  /**
   * Whether any post written here can be published AS another account.
   *
   * Two exclusions, each for its own reason. A REPLY: a channel takes none at
   * all, and `CreateReplyRequest` drops what it does not name — so offering the
   * choice ends in a 201 with the post under the author's own name and nothing
   * saying so. An EDIT: an `UpdatePostRequest` carries no author, and re-signing
   * a published post is not an edit, it is a different post with a different
   * byline.
   *
   * The third exclusion used to be "a thread", which is now a per-box question
   * rather than a composer-wide one — see {@link mainPublishAsEligible} and
   * {@link threadPublishAsEligible}.
   */
  publishAsEligible: boolean;
  /**
   * Whether a box may name its own account, answered per POSTING MODE.
   *
   * BEAST posts are independent — they share a composer and nothing else — so
   * each may go out as a different account, and every box gets the control. A
   * THREAD's continuations are created as replies to their predecessor, which is
   * exactly what a channel post cannot have, so the whole thread stays the
   * author's: a lone root is still eligible (nothing replies to it yet), and the
   * first continuation takes the choice away from it too.
   */
  mainPublishAsEligible: boolean;
  threadPublishAsEligible: boolean;
  /**
   * The account the MAIN post actually goes out as.
   *
   * Derived from the same predicate that gates the wire rather than read from
   * state directly, so a choice the payload would drop — made in beast mode and
   * then switched back to thread — cannot go on being drawn in the header. One
   * value feeds the byline and the request; they cannot disagree.
   */
  effectiveMainPublishAs: AccountNode | null;
  /**
   * Whether the post may be written IN a community. An original post or a
   * THREAD, written as the author themselves: a reply takes its thread's
   * community on the server (and so do a thread's continuations, which are
   * replies), a beast batch is n independent posts the server refuses to file
   * under one community, and a community post is never published as another
   * account.
   */
  communityEligible: boolean;
  /** The community the post actually goes out in; a choice the payload would drop is not drawn either. */
  effectiveCommunity: ComposeCommunity | null;
  /**
   * Whether the ROOT post may attach a Mention job (OxyHQ/Mention#952). Only
   * an organization/project account has jobs to attach — the same eligible
   * employer kinds `MENTION_JOB_ELIGIBLE_EMPLOYER_KINDS` enforces server-side
   * — so posting as "myself" (a personal account) or as a channel never shows
   * the icon at all, rather than showing it disabled.
   */
  canAttachJob: boolean;
}

/**
 * What the composer may offer, and what it will actually send, for the post being
 * written. Pure: every answer is derived from the inputs, so the same rules that
 * hide a control also decide the request payload and the two cannot drift.
 */
export function deriveComposeEligibility(input: ComposeEligibilityInput): ComposeEligibility {
  const { unsupervised, replyToPostId, isEditMode, isDirect, postingMode } = input;
  const isReply = Boolean(replyToPostId);

  const collaboratorsEligible =
    unsupervised &&
    !isReply &&
    input.threadItemCount === 0 &&
    !isDirect &&
    (!isEditMode || input.editCollabEligible);

  const laneEligible = !isReply && !isEditMode && !isDirect;
  const threadLaneEligible = laneEligible && postingMode === 'beast';

  const publishAsEligible = unsupervised && !isReply && !isEditMode && !isDirect;
  const mainPublishAsEligible =
    publishAsEligible && (postingMode === 'beast' || input.threadItemCount === 0);
  const threadPublishAsEligible = publishAsEligible && postingMode === 'beast';
  const effectiveMainPublishAs = mainPublishAsEligible ? input.publishAs : null;

  const communityEligible =
    input.communitiesPreview &&
    !isReply &&
    !isEditMode &&
    (input.threadItemCount === 0 || postingMode === 'thread') &&
    !effectiveMainPublishAs &&
    !isDirect &&
    unsupervised;
  const effectiveCommunity = communityEligible ? input.community : null;

  const canAttachJob = Boolean(
    effectiveMainPublishAs &&
      (effectiveMainPublishAs.kind === 'organization' || effectiveMainPublishAs.kind === 'project'),
  );

  return {
    collaboratorsEligible,
    laneEligible,
    threadLaneEligible,
    publishAsEligible,
    mainPublishAsEligible,
    threadPublishAsEligible,
    effectiveMainPublishAs,
    communityEligible,
    effectiveCommunity,
    canAttachJob,
  };
}
