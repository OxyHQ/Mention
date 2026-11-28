// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { AccountNode } from '@oxy.so/core';
import {
  type ComposeEligibilityInput,
  deriveComposeEligibility,
} from '@/components/Compose/composeEligibility';

const organization = { accountId: 'org-1', kind: 'organization' } as unknown as AccountNode;
const channel = { accountId: 'chan-1', kind: 'channel' } as unknown as AccountNode;
const community = { id: 'community-1', username: 'club' };

/** An original, unsupervised, single-box post: everything is on offer. */
const original: ComposeEligibilityInput = {
  unsupervised: true,
  replyToPostId: undefined,
  isEditMode: false,
  isDirect: false,
  editCollabEligible: false,
  threadItemCount: 0,
  postingMode: 'thread',
  communitiesPreview: true,
  publishAs: null,
  community: null,
};

describe('deriveComposeEligibility', () => {
  it('offers every control on an original post', () => {
    const result = deriveComposeEligibility(original);
    expect(result).toMatchObject({
      collaboratorsEligible: true,
      laneEligible: true,
      publishAsEligible: true,
      mainPublishAsEligible: true,
      communityEligible: true,
    });
  });

  it('offers nothing to a supervised author', () => {
    const result = deriveComposeEligibility({
      ...original,
      unsupervised: false,
      publishAs: channel,
      community,
    });
    expect(result.collaboratorsEligible).toBe(false);
    expect(result.publishAsEligible).toBe(false);
    expect(result.communityEligible).toBe(false);
    expect(result.effectiveMainPublishAs).toBeNull();
    expect(result.effectiveCommunity).toBeNull();
  });

  it('keeps a reply to its parent: no collaborators, lane, account or community', () => {
    const result = deriveComposeEligibility({ ...original, replyToPostId: 'parent-1' });
    expect(result).toMatchObject({
      collaboratorsEligible: false,
      laneEligible: false,
      threadLaneEligible: false,
      publishAsEligible: false,
      communityEligible: false,
    });
  });

  it('never re-signs or re-files a post being edited', () => {
    const result = deriveComposeEligibility({ ...original, isEditMode: true });
    expect(result.laneEligible).toBe(false);
    expect(result.publishAsEligible).toBe(false);
    expect(result.communityEligible).toBe(false);
  });

  it('lets an edit name collaborators only while the stored post is still solo', () => {
    const editing = { ...original, isEditMode: true };
    expect(
      deriveComposeEligibility({ ...editing, editCollabEligible: false }).collaboratorsEligible,
    ).toBe(false);
    expect(
      deriveComposeEligibility({ ...editing, editCollabEligible: true }).collaboratorsEligible,
    ).toBe(true);
  });

  it('treats a private mention as addressed to nobody else', () => {
    const result = deriveComposeEligibility({ ...original, isDirect: true });
    expect(result).toMatchObject({
      collaboratorsEligible: false,
      laneEligible: false,
      publishAsEligible: false,
      communityEligible: false,
    });
  });

  describe('a thread (continuations are replies)', () => {
    const thread = { ...original, threadItemCount: 2, postingMode: 'thread' as const };

    it('drops collaborators, and the account choice once a continuation exists', () => {
      const result = deriveComposeEligibility({ ...thread, publishAs: channel });
      expect(result.collaboratorsEligible).toBe(false);
      expect(result.mainPublishAsEligible).toBe(false);
      expect(result.threadPublishAsEligible).toBe(false);
      expect(result.effectiveMainPublishAs).toBeNull();
    });

    it('gives only the root a lane', () => {
      const result = deriveComposeEligibility(thread);
      expect(result.laneEligible).toBe(true);
      expect(result.threadLaneEligible).toBe(false);
    });

    it('still allows a community, which the whole thread shares', () => {
      expect(deriveComposeEligibility({ ...thread, community }).effectiveCommunity).toEqual(
        community,
      );
    });
  });

  describe('a beast batch (independent posts)', () => {
    const beast = { ...original, threadItemCount: 2, postingMode: 'beast' as const };

    it('lets every box carry its own lane and account', () => {
      const result = deriveComposeEligibility({ ...beast, publishAs: channel });
      expect(result.threadLaneEligible).toBe(true);
      expect(result.threadPublishAsEligible).toBe(true);
      expect(result.mainPublishAsEligible).toBe(true);
      expect(result.effectiveMainPublishAs).toBe(channel);
    });

    it('refuses to file n independent posts under one community', () => {
      const result = deriveComposeEligibility({ ...beast, community });
      expect(result.communityEligible).toBe(false);
      expect(result.effectiveCommunity).toBeNull();
    });
  });

  describe('a choice the payload would drop is not drawn either', () => {
    it('forgets the account chosen in beast mode once the composer is back in thread mode with continuations', () => {
      const result = deriveComposeEligibility({
        ...original,
        threadItemCount: 1,
        postingMode: 'thread',
        publishAs: channel,
      });
      expect(result.effectiveMainPublishAs).toBeNull();
    });

    it('never files a post under a community when it goes out as another account', () => {
      const result = deriveComposeEligibility({ ...original, publishAs: channel, community });
      expect(result.effectiveMainPublishAs).toBe(channel);
      expect(result.communityEligible).toBe(false);
      expect(result.effectiveCommunity).toBeNull();
    });

    it('hides communities where the viewer has none', () => {
      expect(
        deriveComposeEligibility({ ...original, communitiesPreview: false, community })
          .effectiveCommunity,
      ).toBeNull();
    });
  });

  describe('jobs', () => {
    it('are attachable only when posting as an organization or project', () => {
      expect(deriveComposeEligibility({ ...original, publishAs: organization }).canAttachJob).toBe(
        true,
      );
      expect(
        deriveComposeEligibility({
          ...original,
          publishAs: { accountId: 'p', kind: 'project' } as unknown as AccountNode,
        }).canAttachJob,
      ).toBe(true);
      expect(deriveComposeEligibility({ ...original, publishAs: channel }).canAttachJob).toBe(
        false,
      );
      expect(deriveComposeEligibility(original).canAttachJob).toBe(false);
    });

    it('are not attachable on an account choice the payload would drop', () => {
      expect(
        deriveComposeEligibility({
          ...original,
          replyToPostId: 'parent-1',
          publishAs: organization,
        }).canAttachJob,
      ).toBe(false);
    });
  });
});
