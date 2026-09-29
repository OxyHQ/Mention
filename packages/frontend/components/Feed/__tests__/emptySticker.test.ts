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
    ['boosts', 'profileBoosts'],
    ['mentions', 'profileMentions'],
    ['saved', 'saved'],
  ])('%s shows %s', (type, name) => {
    expect(emptySticker(type)).toBe(name);
  });

  it('a thread with no replies is its own case, and "saved only" wins over the type', () => {
    expect(emptySticker('replies', { isThread: true })).toBe('threadNoReplies');
    expect(emptySticker('posts', { showOnlySaved: true })).toBe('saved');
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
