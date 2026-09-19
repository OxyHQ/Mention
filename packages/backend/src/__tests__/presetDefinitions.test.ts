import { describe, it, expect } from 'vitest';
import type { FeedDescriptor } from '@mention/shared-types';
import { resolveDefinition } from '../mtn/feed/definitions/resolveDefinition';
import { discoveryGateModuleIdsForTest } from '../config';

/**
 * Group D — the new preset definitions (Trending, Mutuals, Popular with Friends)
 * resolve to the right module composition + execution profile.
 */

describe('trending definition', () => {
  it('is a ranked engagement/recency feed over the popular source', async () => {
    const def = await resolveDefinition('trending');
    expect(def).not.toBeNull();
    expect(def!.mode).toBe('ranked');
    expect(def!.sources.map((s) => s.module)).toEqual(['popular']);
    expect(def!.signals.map((s) => s.module)).toEqual(['engagement', 'recency']);
    expect(def!.filters.map((f) => f.module)).toEqual(['safety']);
  });
});

/**
 * WHICH SURFACES GATE, AND WHICH DELIBERATELY DO NOT.
 *
 * The negative half matters more than the positive half. A gate appearing on a
 * feed the reader navigated to on purpose is the failure mode this whole change
 * is trying not to have — so those absences are asserted by name rather than
 * left to be noticed.
 */
describe('gate composition across presets', () => {
  const gateOf = async (descriptor: FeedDescriptor) =>
    (await resolveDefinition(descriptor))!.discoveryFilters?.map((f) => f.module) ?? [];

  it('For You and Discover run the full discovery gate', async () => {
    for (const descriptor of ['for_you', 'explore'] as const) {
      expect(await gateOf(descriptor)).toEqual([
        'minLength', 'lowEffortGate', 'nativeEngagement', 'minQuality', 'noContentWarning',
      ]);
    }
  });

  it('Trending, Videos and Media run recommendation HYGIENE only', async () => {
    // Not the full gate: an engagement floor on the feed that IS the
    // high-engagement tail, or a length floor on a feed of videos, would not make
    // them cleaner — it would make them a different feed.
    for (const descriptor of ['trending', 'videos', 'media'] as const) {
      expect(await gateOf(descriptor)).toEqual(['noContentWarning']);
    }
  });

  it('the feeds the reader chose outright are NOT gated', async () => {
    for (const descriptor of ['following', 'saved', 'mutuals', 'author|u1', 'list|l1'] as const) {
      expect(await gateOf(descriptor)).toEqual([]);
    }
  });

  it('the chronological destinations carry the content-warning rule as a plain filter', async () => {
    // They have no trusted-lane notion for a gate to be scoped by; the rule's own
    // followed-author exemption is what scopes it there.
    for (const descriptor of ['hashtag|x', 'topic|t', 'trend|w', 'lane|l'] as const) {
      const def = await resolveDefinition(descriptor);
      expect(def!.filters.map((f) => f.module)).toEqual(['safety', 'noContentWarning']);
      expect(def!.discoveryFilters ?? []).toEqual([]);
    }
  });

  it('every gate ref a preset builds is nameable in FOR_YOU_DISCOVERY_GATE', async () => {
    // Two lists have to agree: this one, and `discoveryGateModuleIds` in
    // `config/index.ts`, which validates the env var. The config list is the one
    // that fails LOUDLY — naming a module it lacks stops the process booting — so
    // assert it covers everything the presets actually build.
    const built = new Set([
      ...(await gateOf('for_you')),
      ...(await gateOf('trending')),
    ]);
    const nameable = new Set(discoveryGateModuleIdsForTest);
    for (const id of built) expect(nameable.has(id)).toBe(true);
  });
});

describe('mutuals definition', () => {
  it('is a chronological single-source mutuals feed with reply context', async () => {
    const def = await resolveDefinition('mutuals');
    expect(def!.mode).toBe('chronological');
    expect(def!.sources.map((s) => s.module)).toEqual(['mutuals']);
    expect(def!.signals).toEqual([]);
    expect(def!.filters.map((f) => f.module)).toEqual(['safety']);
    expect(def!.execution?.hydrateMaxDepth).toBe(1);
    expect(def!.execution?.replyContext).toBe(true);
  });
});

describe('friends_popular definition', () => {
  it('is a ranked feed over the friendsEngaged source (not pre-scored)', async () => {
    const def = await resolveDefinition('friends_popular');
    expect(def!.mode).toBe('ranked');
    expect(def!.sources.map((s) => s.module)).toEqual(['friendsEngaged']);
    expect(def!.signals.map((s) => s.module)).toEqual(['engagement', 'recency']);
    expect(def!.filters.map((f) => f.module)).toEqual(['safety']);
    expect(def!.execution?.preScored).toBe(false);
    expect(def!.execution?.hydrateMaxDepth).toBe(1);
  });
});

describe('friends_of_friends definition', () => {
  it('is a chronological single-source FoF feed with reply context + boost hydration', async () => {
    const def = await resolveDefinition('friends_of_friends');
    expect(def).not.toBeNull();
    expect(def!.mode).toBe('chronological');
    expect(def!.sources.map((s) => s.module)).toEqual(['friendsOfFriends']);
    expect(def!.signals).toEqual([]);
    expect(def!.execution?.hydrateMaxDepth).toBe(1);
    expect(def!.execution?.replyContext).toBe(true);
  });
});

describe('author definition', () => {
  it('the videos tab composes the videoOnly filter', async () => {
    const def = await resolveDefinition('author|u1|videos');
    expect(def!.sources.map((s) => s.module)).toEqual(['authored']);
    expect(def!.sources[0].params).toMatchObject({ authorId: 'u1', filter: 'videos' });
    expect(def!.filters.map((f) => f.module)).toEqual(['videoOnly']);
  });

  it('the media tab still composes mediaOnly, not videoOnly', async () => {
    const def = await resolveDefinition('author|u1|media');
    expect(def!.filters.map((f) => f.module)).toEqual(['mediaOnly']);
  });

  it('every author variant hydrates boosts at depth 1', async () => {
    const def = await resolveDefinition('author|u1|videos');
    expect(def!.execution?.hydrateMaxDepth).toBe(1);
  });
});

describe('resolveDefinition still returns null for unknown descriptors', () => {
  it('unknown → null', async () => {
    expect(await resolveDefinition('nonsense' as FeedDescriptor)).toBeNull();
  });
});
