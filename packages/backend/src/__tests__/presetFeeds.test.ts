import { describe, it, expect } from 'vitest';
import {
  isValidFeedDescriptor,
  PRESET_FEEDS,
  MtnConfig,
} from '@mention/shared-types';
import type { PresetFeed } from '@mention/shared-types';

/**
 * Group A — shared-types tokens, preset catalog, preference types.
 *
 * The new descriptor tokens must validate, the preset catalog must cover the
 * Phase 2 preset feeds, and only For You + Following are pinned by default.
 */

describe('feed descriptor tokens (Phase 2)', () => {
  it('accepts the new preset tokens', () => {
    expect(isValidFeedDescriptor('trending')).toBe(true);
    expect(isValidFeedDescriptor('mutuals')).toBe(true);
    expect(isValidFeedDescriptor('friends_popular')).toBe(true);
  });

  it('still rejects unknown tokens', () => {
    expect(isValidFeedDescriptor('not_a_feed')).toBe(false);
  });

  it('carries frontend cache TTLs for the new feeds', () => {
    expect(MtnConfig.cache.feedTtl.trending).toBe(15000);
    expect(MtnConfig.cache.feedTtl.mutuals).toBe(5000);
    expect(MtnConfig.cache.feedTtl.friends_popular).toBe(10000);
  });
});

describe('PRESET_FEEDS catalog', () => {
  function byDescriptor(descriptor: string): PresetFeed | undefined {
    return PRESET_FEEDS.find((p) => p.descriptor === descriptor);
  }

  it('covers the Phase 2 preset feeds', () => {
    const descriptors = PRESET_FEEDS.map((p) => p.descriptor);
    expect(descriptors).toEqual(
      expect.arrayContaining([
        'for_you', 'following', 'trending', 'explore', 'mutuals', 'friends_popular',
      ]),
    );
  });

  it('pins For You and Following by default; nothing else', () => {
    const pinned = PRESET_FEEDS.filter((p) => p.defaultPinned).map((p) => p.descriptor);
    expect(pinned.sort()).toEqual(['following', 'for_you']);
  });

  it('marks viewer-relative feeds as requiring auth', () => {
    expect(byDescriptor('mutuals')?.requiresAuth).toBe(true);
    expect(byDescriptor('following')?.requiresAuth).toBe(true);
    expect(byDescriptor('friends_popular')?.requiresAuth).toBe(true);
    expect(byDescriptor('trending')?.requiresAuth).toBe(false);
  });

  it('every preset carries label/description/icon metadata', () => {
    for (const preset of PRESET_FEEDS) {
      expect(preset.id).toBeTruthy();
      expect(preset.labelKey).toBeTruthy();
      expect(preset.descriptionKey).toBeTruthy();
      expect(preset.icon).toBeTruthy();
      expect(isValidFeedDescriptor(preset.descriptor)).toBe(true);
    }
  });
});
