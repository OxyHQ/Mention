// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, it, expect } from 'bun:test';
import { PRESET_FEEDS, savedFeedsOfferedTo } from '@mention/shared-types';
import type { FeedDescriptor } from '@mention/shared-types';
import {
  isWithheldFromProtectedProfile,
  resolveDefinition,
} from '../mtn/feed/definitions/resolveDefinition';

function sourceIds(def: { sources: Array<{ module: string }> }): string[] {
  return def.sources.map((s) => s.module);
}

describe('resolveDefinition', () => {
  it('videos → ranked definition with safety filter', async () => {
    const def = await resolveDefinition('videos');
    expect(def!.mode).toBe('ranked');
    expect(def!.sources.map((s) => s.module)).toEqual(['videos']);
    expect(def!.filters.some((f) => f.module === 'safety' && f.enabled)).toBe(true);
  });

  it('for_you → ranked definition with the For You sources', async () => {
    const def = await resolveDefinition('for_you');
    expect(def).not.toBeNull();
    expect(def!.mode).toBe('ranked');
    expect(sourceIds(def!)).toEqual([
      'activitySubscriptions',
      'following',
      'lists',
      'affinity',
      'friendsEngaged',
      'topic',
      'region',
      'trending',
      'globalDiscovery',
      'promotion',
    ]);
    expect(def!.execution?.neverBlank).toBe(true);
  });

  it('following → chronological following definition with safety filter', async () => {
    const def = await resolveDefinition('following');
    expect(def!.mode).toBe('chronological');
    expect(def!.sources[0]).toMatchObject({ module: 'following', params: { timeline: true } });
    expect(def!.filters.some((f) => f.module === 'safety' && f.enabled)).toBe(true);
  });

  it('following_direct → chronological source that excludes subscribed-list-only authors', async () => {
    const def = await resolveDefinition('following_direct');
    expect(def!.mode).toBe('chronological');
    expect(def!.sources[0]).toMatchObject({
      module: 'following',
      params: { timeline: true, directOnly: true },
    });
    expect(def!.filters.some((f) => f.module === 'safety' && f.enabled)).toBe(true);
  });

  it('author|123|media → authored media source + mediaOnly filter (no safety)', async () => {
    const def = await resolveDefinition('author|123|media' as FeedDescriptor);
    expect(def!.mode).toBe('chronological');
    expect(def!.sources[0]).toMatchObject({
      module: 'authored',
      params: { authorId: '123', filter: 'media' },
    });
    expect(def!.filters.some((f) => f.module === 'mediaOnly')).toBe(true);
    expect(def!.filters.some((f) => f.module === 'safety')).toBe(false);
    expect(def!.execution?.hydrateMaxDepth).toBe(1);
  });

  it('author|123 → authored posts source without safety filter', async () => {
    const def = await resolveDefinition('author|123' as FeedDescriptor);
    expect(def!.sources[0]).toMatchObject({
      module: 'authored',
      params: { authorId: '123', filter: 'posts' },
    });
    expect(def!.filters.some((f) => f.module === 'safety')).toBe(false);
  });

  it('author|123|likes → ordered execution', async () => {
    const def = await resolveDefinition('author|123|likes' as FeedDescriptor);
    expect(def!.execution?.ordered).toBe(true);
    expect(def!.sources[0]).toMatchObject({ module: 'authored', params: { filter: 'likes' } });
  });

  it('author|123|mentions → chronological authored source, not the posts fallback', async () => {
    const def = await resolveDefinition('author|123|mentions' as FeedDescriptor);
    expect(def!.id).toBe('author|123|mentions');
    expect(def!.execution?.ordered).toBeFalsy();
    expect(def!.sources[0]).toMatchObject({
      module: 'authored',
      params: { authorId: '123', filter: 'mentions' },
    });
  });

  it('hashtag|Cats → keywords source with lowercased hashtag', async () => {
    const def = await resolveDefinition('hashtag|Cats' as FeedDescriptor);
    expect(def!.sources[0]).toMatchObject({ module: 'keywords', params: { hashtags: ['cats'] } });
  });

  it('topic|art → topic source with slug', async () => {
    const def = await resolveDefinition('topic|art' as FeedDescriptor);
    expect(def!.sources[0]).toMatchObject({ module: 'topic', params: { slug: 'art' } });
  });

  it('list|abc → lists source with listId', async () => {
    const def = await resolveDefinition('list|abc' as FeedDescriptor);
    expect(def!.sources[0]).toMatchObject({ module: 'lists', params: { listId: 'abc' } });
  });

  it('saved → ordered items feed', async () => {
    const def = await resolveDefinition('saved');
    expect(def!.execution?.ordered).toBe(true);
    expect(def!.execution?.markSaved).toBe(true);
  });

  it('custom|id without a viewer context and feedgen|uri return null', async () => {
    expect(await resolveDefinition('custom|abc' as FeedDescriptor)).toBeNull();
    expect(await resolveDefinition('feedgen|at://x' as FeedDescriptor)).toBeNull();
  });

  it('unknown descriptor → null', async () => {
    expect(await resolveDefinition('nonsense' as FeedDescriptor)).toBeNull();
  });
});

/**
 * A minor's feed profile (oxy ADR 0068): nothing ranked by engagement. The rule
 * reads the resolved definition's `mode`, so these cases would also catch a
 * ranked feed added later that nobody listed.
 */
describe('resolveDefinition for a protected profile', () => {
  const protectedViewer = { currentUserId: 'viewer', feedProfile: 'protected' } as const;

  it('serves the home feed as the chronological Following timeline', async () => {
    const def = await resolveDefinition('for_you', protectedViewer);
    expect(def!.id).toBe('following');
    expect(def!.mode).toBe('chronological');
    expect(sourceIds(def!)).toEqual(['following']);
    expect(await isWithheldFromProtectedProfile('for_you', protectedViewer)).toBe(false);
  });

  it('serves Following chronologically even when relevance was asked for', async () => {
    const def = await resolveDefinition('following', {
      ...protectedViewer,
      followingSort: 'relevance',
    });
    expect(def!.mode).toBe('chronological');
    // The same request from a standard profile is ranked: the profile is what changed it.
    const standard = await resolveDefinition('following', {
      currentUserId: 'viewer',
      followingSort: 'relevance',
    });
    expect(standard!.mode).toBe('ranked');
  });

  it.each(['explore', 'trending', 'videos', 'media', 'friends_popular'] as FeedDescriptor[])(
    'withholds the ranked feed %s',
    async (descriptor) => {
      expect((await resolveDefinition(descriptor))!.mode).toBe('ranked');
      expect(await resolveDefinition(descriptor, protectedViewer)).toBeNull();
      expect(await isWithheldFromProtectedProfile(descriptor, protectedViewer)).toBe(true);
    },
  );

  it.each(['mutuals', 'saved', 'author|someone', 'hashtag|cats'] as FeedDescriptor[])(
    'still serves the chronological feed %s',
    async (descriptor) => {
      const def = await resolveDefinition(descriptor, protectedViewer);
      expect(def).not.toBeNull();
      expect(def!.mode).toBe('chronological');
      expect(await isWithheldFromProtectedProfile(descriptor, protectedViewer)).toBe(false);
    },
  );

  it('serves no ranked definition at all, whatever the preset', async () => {
    const presets: FeedDescriptor[] = [
      'for_you',
      'following',
      'following_direct',
      'explore',
      'videos',
      'media',
      'saved',
      'trending',
      'mutuals',
      'friends_popular',
      'friends_of_friends',
      'trend|cats|top',
    ];
    let served = 0;
    for (const descriptor of presets) {
      const def = await resolveDefinition(descriptor, {
        ...protectedViewer,
        followingSort: 'relevance',
      });
      if (def === null) continue;
      served += 1;
      expect(def.mode).toBe('chronological');
    }
    // A floor, so the loop cannot pass by resolving nothing.
    expect(served).toBeGreaterThanOrEqual(5);
  });

  it('does not call a descriptor that names nothing withheld', async () => {
    expect(await resolveDefinition('feedgen|at://x' as FeedDescriptor, protectedViewer)).toBeNull();
    expect(
      await isWithheldFromProtectedProfile('feedgen|at://x' as FeedDescriptor, protectedViewer),
    ).toBe(false);
  });

  it('changes nothing for a standard or absent profile', async () => {
    expect((await resolveDefinition('for_you', { feedProfile: 'standard' }))!.mode).toBe('ranked');
    expect((await resolveDefinition('for_you', {}))!.mode).toBe('ranked');
  });
});

/**
 * The client decides which presets to OFFER from `PRESET_FEEDS[].ranked`; the
 * server decides which to SERVE from each definition's `mode`. These hold the
 * two together, so a preset cannot be offered to a minor and then refused, nor
 * hidden while it would have been served.
 */
describe('PRESET_FEEDS.ranked agrees with the definitions', () => {
  it.each(PRESET_FEEDS.map((preset) => [preset.id, preset] as const))(
    'for %s',
    async (_id, preset) => {
      const definition = await resolveDefinition(preset.descriptor, { currentUserId: 'viewer' });
      expect(definition).not.toBeNull();
      expect(definition!.mode === 'ranked').toBe(preset.ranked);
    },
  );

  it('offers a protected profile exactly the presets the server would serve as themselves', async () => {
    const all = PRESET_FEEDS.map((preset, order) => ({
      key: preset.id,
      descriptor: preset.descriptor,
      pinned: preset.defaultPinned,
      order,
    }));
    const offered = savedFeedsOfferedTo(all, 'protected').map((feed) => feed.key);
    expect(offered).toEqual(['following', 'mutuals', 'friends_of_friends']);
    for (const key of offered) {
      const preset = PRESET_FEEDS.find((entry) => entry.id === key);
      const served = await resolveDefinition(preset!.descriptor, {
        currentUserId: 'viewer',
        feedProfile: 'protected',
      });
      expect(served!.mode).toBe('chronological');
    }
    // A standard profile is offered everything, unchanged.
    expect(savedFeedsOfferedTo(all, 'standard')).toEqual(all);
  });
});
