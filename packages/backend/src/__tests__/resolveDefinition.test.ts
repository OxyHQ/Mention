import { describe, it, expect } from 'vitest';
import type { FeedDescriptor } from '@mention/shared-types';
import { resolveDefinition } from '../mtn/feed/definitions/resolveDefinition';

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
      'following', 'lists', 'affinity', 'topic', 'language', 'region', 'trending', 'globalDiscovery',
    ]);
    expect(def!.execution?.neverBlank).toBe(true);
  });

  it('following → chronological following definition with safety filter', async () => {
    const def = await resolveDefinition('following');
    expect(def!.mode).toBe('chronological');
    expect(def!.sources[0]).toMatchObject({ module: 'following', params: { timeline: true } });
    expect(def!.filters.some((f) => f.module === 'safety' && f.enabled)).toBe(true);
  });

  it('author|123|media → authored media source + mediaOnly filter (no safety)', async () => {
    const def = await resolveDefinition('author|123|media' as FeedDescriptor);
    expect(def!.mode).toBe('chronological');
    expect(def!.sources[0]).toMatchObject({ module: 'authored', params: { authorId: '123', filter: 'media' } });
    expect(def!.filters.some((f) => f.module === 'mediaOnly')).toBe(true);
    expect(def!.filters.some((f) => f.module === 'safety')).toBe(false);
    expect(def!.execution?.hydrateMaxDepth).toBe(1);
  });

  it('author|123 → authored posts source without safety filter', async () => {
    const def = await resolveDefinition('author|123' as FeedDescriptor);
    expect(def!.sources[0]).toMatchObject({ module: 'authored', params: { authorId: '123', filter: 'posts' } });
    expect(def!.filters.some((f) => f.module === 'safety')).toBe(false);
  });

  it('author|123|likes → ordered execution', async () => {
    const def = await resolveDefinition('author|123|likes' as FeedDescriptor);
    expect(def!.execution?.ordered).toBe(true);
    expect(def!.sources[0]).toMatchObject({ module: 'authored', params: { filter: 'likes' } });
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
