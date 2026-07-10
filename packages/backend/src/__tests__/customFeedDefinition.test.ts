import { beforeEach, describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Task 4 — custom feeds resolve to runnable engine definitions:
 * `buildCustomFeedDefinition` (stored definition or legacy fallback + execution
 * profile) and `loadCustomFeedDefinition` (id/owner/visibility gate).
 */

let feedDoc: Record<string, unknown> | null = null;
vi.mock('../models/CustomFeed', () => ({
  default: { findById: vi.fn(() => ({ lean: async () => feedDoc })) },
}));

import { buildCustomFeedDefinition, loadCustomFeedDefinition } from '../mtn/feed/definitions/customFeedDefinition';

const storedDefinition = {
  mode: 'chronological' as const,
  sources: [{ module: 'keywords', enabled: true, params: { hashtags: ['comics'] } }],
  signals: [],
  filters: [],
};

beforeEach(() => {
  feedDoc = null;
  vi.clearAllMocks();
});

describe('buildCustomFeedDefinition', () => {
  it('strips onlySensitive and injects safety when absent', () => {
    const def = buildCustomFeedDefinition({
      _id: 'feed-1',
      title: 'NSFW attempt',
      isPublic: true,
      definition: {
        ...storedDefinition,
        filters: [{ module: 'onlySensitive', enabled: true }],
      },
    });
    expect(def.filters.some((f) => f.module === 'onlySensitive')).toBe(false);
    expect(def.filters.some((f) => f.module === 'safety' && f.enabled)).toBe(true);
  });

  it('keeps excludeSensitive and does not duplicate safety', () => {
    const def = buildCustomFeedDefinition({
      _id: 'feed-1',
      title: 'SFW custom',
      isPublic: true,
      definition: {
        ...storedDefinition,
        filters: [{ module: 'excludeSensitive', enabled: true }],
      },
    });
    expect(def.filters.filter((f) => f.module === 'safety')).toHaveLength(0);
    expect(def.filters.some((f) => f.module === 'excludeSensitive' && f.enabled)).toBe(true);
  });

  it('uses the stored definition, attaches id/title, and hydrates boosts (depth 1)', () => {
    const def = buildCustomFeedDefinition({ _id: 'feed-1', title: 'Comics', isPublic: true, definition: storedDefinition });
    expect(def.id).toBe('custom|feed-1');
    expect(def.title).toBe('Comics');
    expect(def.mode).toBe('chronological');
    expect(def.sources).toEqual(storedDefinition.sources);
    expect(def.execution?.hydrateMaxDepth).toBe(1);
    expect(def.execution?.maxPool).toBeUndefined(); // chronological → no pool cap
  });

  it('drops boost-hydration depth when the definition excludes boosts', () => {
    const def = buildCustomFeedDefinition({
      _id: 'feed-1',
      title: 'No boosts',
      isPublic: true,
      definition: { ...storedDefinition, filters: [{ module: 'noBoosts', enabled: true }] },
    });
    expect(def.execution?.hydrateMaxDepth).toBe(0);
  });

  it('bounds the pool for a ranked definition', () => {
    const def = buildCustomFeedDefinition({
      _id: 'feed-1',
      title: 'Ranked',
      isPublic: true,
      definition: { mode: 'ranked', sources: [{ module: 'trending', enabled: true }], signals: [], filters: [] },
    });
    expect(def.execution?.maxPool).toBeGreaterThan(0);
  });

  it('falls back to legacy fields when no stored definition exists', () => {
    const def = buildCustomFeedDefinition({
      _id: 'feed-1',
      title: 'Legacy',
      isPublic: true,
      ownerOxyUserId: 'owner-1',
      memberOxyUserIds: ['a1'],
      keywords: ['art'],
    });
    expect(def.mode).toBe('chronological');
    expect(def.sources.map((s) => s.module)).toEqual(['accounts', 'keywords']);
    // owner excluded via muteBlock (owner not a member)
    expect(def.filters.some((f) => f.module === 'muteBlock')).toBe(true);
  });
});

describe('loadCustomFeedDefinition', () => {
  it('returns null for an invalid id (no DB read)', async () => {
    expect(await loadCustomFeedDefinition('not-an-id', 'viewer')).toBeNull();
  });

  it('returns null when the feed is missing', async () => {
    feedDoc = null;
    expect(await loadCustomFeedDefinition(new mongoose.Types.ObjectId().toString(), 'viewer')).toBeNull();
  });

  it('returns null for a private feed the viewer does not own', async () => {
    feedDoc = { _id: 'f1', title: 't', isPublic: false, ownerOxyUserId: 'someone-else', definition: storedDefinition };
    expect(await loadCustomFeedDefinition(new mongoose.Types.ObjectId().toString(), 'viewer')).toBeNull();
  });

  it('resolves a public feed for any viewer', async () => {
    feedDoc = { _id: 'f1', title: 't', isPublic: true, ownerOxyUserId: 'someone-else', definition: storedDefinition };
    const def = await loadCustomFeedDefinition(new mongoose.Types.ObjectId().toString(), 'viewer');
    expect(def?.mode).toBe('chronological');
  });

  it('resolves a private feed for its owner', async () => {
    feedDoc = { _id: 'f1', title: 't', isPublic: false, ownerOxyUserId: 'viewer', definition: storedDefinition };
    const def = await loadCustomFeedDefinition(new mongoose.Types.ObjectId().toString(), 'viewer');
    expect(def).not.toBeNull();
  });
});
