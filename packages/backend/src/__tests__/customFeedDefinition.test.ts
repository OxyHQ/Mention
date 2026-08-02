import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * Custom feeds resolve to runnable engine definitions:
 * `buildCustomFeedDefinition` (stored definition or legacy fallback + execution
 * profile) and `loadCustomFeedDefinition` (id/owner/visibility gate).
 *
 * `buildCustomFeedDefinition` is pure and is called directly. The LOADER is
 * exercised against real rows: it used to mock `models/CustomFeed`, which
 * nothing writes any more — every write goes through
 * `routes/customFeeds.routes.ts` into `custom_feeds` — so the mock stood in for
 * a read that could never succeed, and a feed created after that move loaded as
 * "not found". A mocked `findById` returns whatever it is handed regardless of
 * which store the code is actually asking.
 */

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { customFeedDefinitionModules, customFeeds } from '../db/schema/feeds';
import { buildCustomFeedDefinition, loadCustomFeedDefinition } from '../mtn/feed/definitions/customFeedDefinition';

/** Scoped to this file: `custom_feeds` is shared by every parallel suite. */
const OWNER = 'oxy-cfd-owner';
const VIEWER = 'oxy-cfd-viewer';

/** Insert a feed carrying the stored composable definition; returns its id. */
async function seedFeed(options: { owner: string; isPublic: boolean }): Promise<string> {
  const [row] = await getDb()
    .insert(customFeeds)
    .values({
      ownerOxyUserId: options.owner,
      title: 'cfd feed',
      isPublic: options.isPublic,
      definitionMode: 'chronological',
    })
    .returning({ id: customFeeds.id });
  await getDb().insert(customFeedDefinitionModules).values({
    feedId: row.id,
    kind: 'source',
    position: 0,
    module: 'keywords',
    enabled: true,
    params: { hashtags: ['comics'] },
  });
  return row.id;
}

const storedDefinition = {
  mode: 'chronological' as const,
  sources: [{ module: 'keywords', enabled: true, params: { hashtags: ['comics'] } }],
  signals: [],
  filters: [],
};

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  // `custom_feed_definition_modules` cascades from `custom_feeds`.
  await getDb().delete(customFeeds).where(eq(customFeeds.ownerOxyUserId, OWNER));
  await getDb().delete(customFeeds).where(eq(customFeeds.ownerOxyUserId, VIEWER));
});

afterAll(async () => {
  await closePostgres();
});

describe('buildCustomFeedDefinition', () => {
  it('injects safety when filters is null or undefined', () => {
    const fromNull = buildCustomFeedDefinition({
      _id: 'feed-1',
      title: 'Null filters',
      isPublic: true,
      definition: { ...storedDefinition, filters: null as never },
    });
    expect(fromNull.filters.some((f) => f.module === 'safety' && f.enabled)).toBe(true);

    const fromUndefined = buildCustomFeedDefinition({
      _id: 'feed-1',
      title: 'Undefined filters',
      isPublic: true,
      definition: { ...storedDefinition, filters: undefined as never },
    });
    expect(fromUndefined.filters.some((f) => f.module === 'safety' && f.enabled)).toBe(true);
  });

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
  it('returns null for an empty id', async () => {
    expect(await loadCustomFeedDefinition('', VIEWER)).toBeNull();
    expect(await loadCustomFeedDefinition(undefined, VIEWER)).toBeNull();
  });

  it('returns null when no feed has that id', async () => {
    expect(await loadCustomFeedDefinition('cfd-no-such-feed', VIEWER)).toBeNull();
  });

  it('returns null for a private feed the viewer does not own', async () => {
    const feedId = await seedFeed({ owner: OWNER, isPublic: false });
    expect(await loadCustomFeedDefinition(feedId, VIEWER)).toBeNull();
  });

  it('resolves a public feed for any viewer', async () => {
    const feedId = await seedFeed({ owner: OWNER, isPublic: true });
    const def = await loadCustomFeedDefinition(feedId, VIEWER);
    expect(def?.mode).toBe('chronological');
    // The stored MODULE came back too, which is what says the child-table
    // reassembly ran rather than just the parent row.
    expect(def?.sources.some((source) => source.module === 'keywords')).toBe(true);
  });

  it('resolves a private feed for its owner', async () => {
    const feedId = await seedFeed({ owner: VIEWER, isPublic: false });
    expect(await loadCustomFeedDefinition(feedId, VIEWER)).not.toBeNull();
  });

  it('resolves a feed whose id is a uuid, which the old shape guard refused', async () => {
    // The regression this port fixes. `custom_feeds.id` is uuid v7, and the
    // previous `ObjectId.isValid` guard returned null before any read — so a
    // feed the user had just built loaded as "not found".
    const feedId = await seedFeed({ owner: OWNER, isPublic: true });
    expect(feedId).not.toMatch(/^[0-9a-f]{24}$/);
    expect(await loadCustomFeedDefinition(feedId, VIEWER)).not.toBeNull();
  });
});
