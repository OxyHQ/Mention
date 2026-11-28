// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Which catalogue sticker each empty feed shows (`emptySticker`), next to the
 * words it shows (`emptyCopy`). The choices themselves were made screen by
 * screen; this pins them so a refactor of the feed switch cannot quietly move
 * a profile tab onto another tab's sticker, and every name must resolve to a
 * catalogue id in `lib/stickers.ts`.
 */
import type { FeedType } from '@mention/shared-types';
import { EMPTY_STATE_STICKERS } from '@/lib/stickers';
import { emptySticker } from '../FeedEmptyState';

jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: 'EmptyState' }));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: 'Loading' }));

describe('emptySticker', () => {
  it.each<[FeedType, string]>([
    ['following', 'feedFollowing'],
    ['for_you', 'feedForYou'],
    ['explore', 'feedExplore'],
    ['hashtag', 'feedHashtag'],
    ['custom', 'feedCustom'],
    ['posts', 'profilePosts'],
    ['replies', 'profileReplies'],
    ['media', 'profileMedia'],
    ['videos', 'profileVideos'],
    ['likes', 'profileLikes'],
    ['reposts', 'profileBoosts'],
    ['mentions', 'profileMentions'],
    ['saved', 'saved'],
  ])('%s shows %s', (type, name) => {
    expect(emptySticker(type)).toBe(name);
  });

  it('a thread with no replies is its own case', () => {
    expect(emptySticker('replies', { isThread: true })).toBe('threadNoReplies');
  });

  it('falls back to the following feed for a type with no sticker of its own', () => {
    expect(emptySticker('trending')).toBe('feedFollowing');
  });

  it('names only stickers that resolve to a catalogue id', () => {
    for (const value of Object.values(EMPTY_STATE_STICKERS)) {
      expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});
