import { describe, it, expect } from 'vitest';
import type { FeedDescriptor } from '@mention/shared-types';
import { resolveDefinition } from '../mtn/feed/definitions/resolveDefinition';

function sourceIds(def: { sources: Array<{ module: string }> }): string[] {
  return def.sources.map((s) => s.module);
}

describe('resolveDefinition', () => {
  it('for_you → ranked definition with the For You sources', () => {
    const def = resolveDefinition('for_you');
    expect(def).not.toBeNull();
    expect(def!.mode).toBe('ranked');
    expect(sourceIds(def!)).toEqual([
      'following', 'lists', 'affinity', 'topic', 'language', 'region', 'trending', 'globalDiscovery',
    ]);
    expect(def!.execution?.neverBlank).toBe(true);
  });

  it('following → chronological following definition', () => {
    const def = resolveDefinition('following');
    expect(def!.mode).toBe('chronological');
    expect(def!.sources[0]).toMatchObject({ module: 'following', params: { timeline: true } });
  });

  it('author|123|media → authored media source + mediaOnly filter', () => {
    const def = resolveDefinition('author|123|media' as FeedDescriptor);
    expect(def!.mode).toBe('chronological');
    expect(def!.sources[0]).toMatchObject({ module: 'authored', params: { authorId: '123', filter: 'media' } });
    expect(def!.filters.some((f) => f.module === 'mediaOnly')).toBe(true);
    expect(def!.execution?.hydrateMaxDepth).toBe(1);
  });

  it('author|123 → authored posts source (default filter)', () => {
    const def = resolveDefinition('author|123' as FeedDescriptor);
    expect(def!.sources[0]).toMatchObject({ module: 'authored', params: { authorId: '123', filter: 'posts' } });
  });

  it('author|123|likes → ordered execution', () => {
    const def = resolveDefinition('author|123|likes' as FeedDescriptor);
    expect(def!.execution?.ordered).toBe(true);
    expect(def!.sources[0]).toMatchObject({ module: 'authored', params: { filter: 'likes' } });
  });

  it('hashtag|Cats → keywords source with lowercased hashtag', () => {
    const def = resolveDefinition('hashtag|Cats' as FeedDescriptor);
    expect(def!.sources[0]).toMatchObject({ module: 'keywords', params: { hashtags: ['cats'] } });
  });

  it('topic|art → topic source with slug', () => {
    const def = resolveDefinition('topic|art' as FeedDescriptor);
    expect(def!.sources[0]).toMatchObject({ module: 'topic', params: { slug: 'art' } });
  });

  it('list|abc → lists source with listId', () => {
    const def = resolveDefinition('list|abc' as FeedDescriptor);
    expect(def!.sources[0]).toMatchObject({ module: 'lists', params: { listId: 'abc' } });
  });

  it('saved → ordered items feed', () => {
    const def = resolveDefinition('saved');
    expect(def!.execution?.ordered).toBe(true);
    expect(def!.execution?.markSaved).toBe(true);
  });

  it('custom|id and feedgen|uri return null (not engine-owned in Phase 1)', () => {
    expect(resolveDefinition('custom|abc' as FeedDescriptor)).toBeNull();
    expect(resolveDefinition('feedgen|at://x' as FeedDescriptor)).toBeNull();
  });

  it('unknown descriptor → null', () => {
    expect(resolveDefinition('nonsense' as FeedDescriptor)).toBeNull();
  });
});
