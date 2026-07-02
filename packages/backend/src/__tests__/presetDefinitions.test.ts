import { describe, it, expect } from 'vitest';
import type { FeedDescriptor } from '@mention/shared-types';
import { resolveDefinition } from '../mtn/feed/definitions/resolveDefinition';

/**
 * Group D — the new preset definitions (Trending, Mutuals, Popular with Friends)
 * resolve to the right module composition + execution profile.
 */

describe('trending definition', () => {
  it('is a ranked engagement/recency feed over the popular source', () => {
    const def = resolveDefinition('trending');
    expect(def).not.toBeNull();
    expect(def!.mode).toBe('ranked');
    expect(def!.sources.map((s) => s.module)).toEqual(['popular']);
    expect(def!.signals.map((s) => s.module)).toEqual(['engagement', 'recency']);
    expect(def!.filters.map((f) => f.module)).toEqual(['safety']);
    expect(def!.execution?.passSensitiveOptIn).toBe(true);
  });
});

describe('mutuals definition', () => {
  it('is a chronological single-source mutuals feed with reply context', () => {
    const def = resolveDefinition('mutuals');
    expect(def!.mode).toBe('chronological');
    expect(def!.sources.map((s) => s.module)).toEqual(['mutuals']);
    expect(def!.signals).toEqual([]);
    expect(def!.execution?.hydrateMaxDepth).toBe(1);
    expect(def!.execution?.replyContext).toBe(true);
  });
});

describe('friends_popular definition', () => {
  it('is a ranked feed over the friendsEngaged source (not pre-scored)', () => {
    const def = resolveDefinition('friends_popular');
    expect(def!.mode).toBe('ranked');
    expect(def!.sources.map((s) => s.module)).toEqual(['friendsEngaged']);
    expect(def!.signals.map((s) => s.module)).toEqual(['engagement', 'recency']);
    expect(def!.filters.map((f) => f.module)).toEqual(['safety']);
    expect(def!.execution?.preScored).toBe(false);
    expect(def!.execution?.hydrateMaxDepth).toBe(1);
  });
});

describe('resolveDefinition still returns null for unknown descriptors', () => {
  it('unknown → null', () => {
    expect(resolveDefinition('nonsense' as FeedDescriptor)).toBeNull();
  });
});
