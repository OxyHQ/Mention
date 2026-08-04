/**
 * The custom-feed STORAGE contract, against real Postgres.
 *
 * This file used to construct a Mongoose document offline and assert its
 * `toObject()` — which proved the schema declared the fields and nothing about
 * whether a row survives a round trip. The same four properties are asserted
 * here against the tables that replaced the document:
 *
 *  - the composable definition round-trips, including `params` (jsonb, because a
 *    module's parameters are defined by the module) and `weight`;
 *  - module ORDER is preserved, because module order is evaluation order;
 *  - a nonsense `mode` is REFUSED — by a CHECK constraint now, which unlike a
 *    Mongoose enum also holds on an UPDATE;
 *  - the seven LEGACY filter fields are still stored and still read, and a feed
 *    with no definition is distinguishable from one with an empty definition.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { isCheckViolation } from '../db/pgErrors';
import { customFeedDefinitionModules, customFeeds } from '../db/schema/feeds';

let db: Database;
const createdFeedIds: string[] = [];

async function seedFeed(values: Partial<typeof customFeeds.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(customFeeds)
    .values({
      ownerOxyUserId: `owner-${randomUUID()}`,
      title: 'Comics',
      ...values,
    })
    .returning({ id: customFeeds.id });
  createdFeedIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (createdFeedIds.length > 0) {
    await db.delete(customFeeds).where(inArray(customFeeds.id, createdFeedIds.splice(0)));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('the composable definition', () => {
  it('round-trips modules with their params and weights, in order', async () => {
    const feedId = await seedFeed({ definitionMode: 'ranked', icon: 'sparkles' });
    await db.insert(customFeedDefinitionModules).values([
      { feedId, kind: 'source', position: 0, module: 'accounts', enabled: true, params: { authorIds: ['a1', 'a2'] } },
      { feedId, kind: 'source', position: 1, module: 'keywords', enabled: true, params: { keywords: ['comic'], hashtags: ['comics'] } },
      { feedId, kind: 'signal', position: 0, module: 'engagement', enabled: true, weight: 2 },
      { feedId, kind: 'filter', position: 0, module: 'noReplies', enabled: true },
    ]);

    const [feed] = await db.select().from(customFeeds).where(eq(customFeeds.id, feedId));
    expect(feed.definitionMode).toBe('ranked');
    expect(feed.icon).toBe('sparkles');

    const modules = await db
      .select()
      .from(customFeedDefinitionModules)
      .where(eq(customFeedDefinitionModules.feedId, feedId))
      .orderBy(customFeedDefinitionModules.kind, customFeedDefinitionModules.position);

    const sources = modules.filter((m) => m.kind === 'source');
    expect(sources.map((m) => m.module)).toEqual(['accounts', 'keywords']);
    // `params` is shape-less on purpose — arbitrary keys survive unprojected.
    expect(sources[0].params).toEqual({ authorIds: ['a1', 'a2'] });
    expect(sources[1].params).toEqual({ keywords: ['comic'], hashtags: ['comics'] });

    const signal = modules.find((m) => m.kind === 'signal');
    expect(signal).toMatchObject({ module: 'engagement', enabled: true, weight: 2 });
    expect(modules.find((m) => m.kind === 'filter')).toMatchObject({
      module: 'noReplies',
      enabled: true,
    });
  });

  it('accepts a chronological definition', async () => {
    const feedId = await seedFeed({ definitionMode: 'chronological' });
    const [feed] = await db.select().from(customFeeds).where(eq(customFeeds.id, feedId));
    expect(feed.definitionMode).toBe('chronological');
  });

  it('REFUSES a mode outside the closed set, on an update as well as an insert', async () => {
    /**
     * The Mongoose enum was only enforced on a document save, so
     * `CustomFeed.updateOne` could put anything in the field. A CHECK holds on
     * every write path, which is why `schema/CONVENTIONS.md` chose `text` + a
     * CHECK over a pg enum.
     */
    await expect(
      db.insert(customFeeds).values({
        ownerOxyUserId: `owner-${randomUUID()}`,
        title: 'Bad',
        definitionMode: sql`'nonsense'`,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isCheckViolation(error, 'custom_feeds_definition_mode_check'),
    );

    const feedId = await seedFeed({ definitionMode: 'ranked' });
    await expect(
      db
        .update(customFeeds)
        .set({ definitionMode: sql`'nonsense'` })
        .where(eq(customFeeds.id, feedId)),
    ).rejects.toSatisfy((error: unknown) =>
      isCheckViolation(error, 'custom_feeds_definition_mode_check'),
    );
  });

  it('refuses two modules of one kind at the same position', async () => {
    // `(feed_id, kind, position)` is what makes "module order is evaluation
    // order" a fact rather than a hope.
    const feedId = await seedFeed({ definitionMode: 'chronological' });
    await db
      .insert(customFeedDefinitionModules)
      .values({ feedId, kind: 'source', position: 0, module: 'keywords', enabled: true });
    await expect(
      db
        .insert(customFeedDefinitionModules)
        .values({ feedId, kind: 'source', position: 0, module: 'accounts', enabled: true }),
    ).rejects.toThrow();
  });
});

describe('the legacy filter fields, which are STILL READ', () => {
  it('stores and returns all seven, alongside no definition at all', async () => {
    const feedId = await seedFeed({
      title: 'Legacy',
      keywords: ['art'],
      includeReplies: false,
      includeBoosts: false,
      includeMedia: false,
      language: 'es',
      category: 'culture',
      tags: ['gallery'],
      coverImage: 'cover-1',
    });

    const [feed] = await db.select().from(customFeeds).where(eq(customFeeds.id, feedId));
    expect(feed.keywords).toEqual(['art']);
    expect(feed.includeReplies).toBe(false);
    expect(feed.includeBoosts).toBe(false);
    expect(feed.includeMedia).toBe(false);
    expect(feed.language).toBe('es');
    expect(feed.category).toBe('culture');
    expect(feed.tags).toEqual(['gallery']);
    expect(feed.coverImage).toBe('cover-1');
    // NULL means "this feed predates the composable definition", which is what
    // makes the request-time legacy fallback fire. An empty definition would be
    // a different thing entirely: it renders empty.
    expect(feed.definitionMode).toBeNull();
  });

  it('defaults the three include flags to true, as the Mongoose schema did', async () => {
    const feedId = await seedFeed();
    const [feed] = await db.select().from(customFeeds).where(eq(customFeeds.id, feedId));
    expect(feed.includeReplies).toBe(true);
    expect(feed.includeBoosts).toBe(true);
    expect(feed.includeMedia).toBe(true);
    expect(feed.isPublic).toBe(false);
    expect(feed.subscriberCount).toBe(0);
    expect(feed.averageRating).toBe(0);
    expect(feed.ratingsCount).toBe(0);
  });
});

describe('the owner index', () => {
  it('exists, so the per-owner listing is not a table scan', async () => {
    // The Mongoose version asserted `schema.path('ownerOxyUserId').options.index`.
    // The catalogue is the equivalent statement about the database that ships.
    const rows = await db.execute(
      sql`select indexname from pg_indexes where tablename = 'custom_feeds'`,
    );
    const names = [...rows].map((row) => String((row as { indexname: unknown }).indexname));
    expect(names).toContain('custom_feeds_owner_chrono_idx');
  });
});
