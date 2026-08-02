/**
 * One-shot migration mapping a legacy custom feed's filter columns onto a
 * composable definition, against REAL rows.
 *
 * It used to run over an in-memory store behind a mocked `CustomFeed` model.
 * That model has no writer left — every custom feed goes through
 * `routes/customFeeds.routes.ts` into `custom_feeds` — so the mock was
 * intercepting an import the script no longer performs, and the whole file was
 * asserting a migration of a store nobody reads.
 *
 * Real rows also make two things checkable that the in-memory version could not
 * express, because both are consequences of the definition living in TWO tables:
 *
 *  - the mode and the module lists must commit TOGETHER (`definitionOf` returns
 *    a definition the moment the mode is non-null, so a feed stamped without its
 *    modules stops falling back to its legacy columns and renders EMPTY);
 *  - each feed must receive its OWN definition. A single mis-scoped `WHERE` in
 *    the per-feed update stamps every un-migrated feed with whichever definition
 *    happened to be in hand, and every row still typechecks.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { customFeedDefinitionModules, customFeedMembers, customFeeds } from '../db/schema/feeds';
import { definitionOf, loadFeed } from '../db/feeds/customFeedRepository';
import { backfillCustomFeedDefinitions } from '../scripts/backfillCustomFeedDefinitions';

/** Namespaces every feed this file writes, so a parallel file cannot collide. */
const OWNER_PREFIX = 'oxy-bcfd-';

function owner(name: string): string {
  return `${OWNER_PREFIX}${name}`;
}

/** Seed a legacy feed — no `definition_mode`, legacy columns populated. */
async function seedLegacyFeed(options: {
  ownerOxyUserId: string;
  memberOxyUserIds?: string[];
  keywords?: string[];
  language?: string;
  includeReplies?: boolean;
  includeBoosts?: boolean;
  includeMedia?: boolean;
}): Promise<string> {
  const [row] = await getDb()
    .insert(customFeeds)
    .values({
      ownerOxyUserId: options.ownerOxyUserId,
      title: 'legacy feed',
      keywords: options.keywords ?? null,
      language: options.language ?? null,
      // The three toggles are NOT NULL DEFAULT true, so an unset one is omitted
      // rather than written as null — which is also the legacy "include" state.
      ...(options.includeReplies === undefined ? {} : { includeReplies: options.includeReplies }),
      ...(options.includeBoosts === undefined ? {} : { includeBoosts: options.includeBoosts }),
      ...(options.includeMedia === undefined ? {} : { includeMedia: options.includeMedia }),
    })
    .returning({ id: customFeeds.id });

  const members = options.memberOxyUserIds ?? [];
  if (members.length > 0) {
    await getDb().insert(customFeedMembers).values(
      members.map((oxyUserId, position) => ({ feedId: row.id, oxyUserId, position })),
    );
  }
  return row.id;
}

/** The migrated definition as the READ path reassembles it. */
async function storedDefinition(feedId: string) {
  const loaded = await loadFeed(getDb(), feedId);
  if (!loaded) return undefined;
  return definitionOf(loaded.row, loaded.relations);
}

/** Just the module ids of one list, in stored order. */
async function moduleIds(
  feedId: string,
  kind: 'source' | 'signal' | 'filter',
): Promise<string[]> {
  const definition = await storedDefinition(feedId);
  if (!definition) return [];
  const list = kind === 'source'
    ? definition.sources
    : kind === 'signal'
      ? definition.signals
      : definition.filters;
  return (list ?? []).map((ref) => ref.module);
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  // Members and definition modules both cascade from `custom_feeds`.
  await getDb().delete(customFeeds).where(like(customFeeds.ownerOxyUserId, `${OWNER_PREFIX}%`));
});

afterAll(async () => {
  await closePostgres();
});

describe('mapping a legacy feed', () => {
  it('maps members, keywords and toggles, excludes the owner, and is idempotent', async () => {
    const feedId = await seedLegacyFeed({
      ownerOxyUserId: owner('a'),
      memberOxyUserIds: ['m1', 'm2'],
      keywords: ['drizzle'],
      language: 'es',
      includeReplies: false,
      includeBoosts: false,
    });

    const first = await backfillCustomFeedDefinitions();
    expect(first.failed).toBe(0);

    const definition = await storedDefinition(feedId);
    expect(definition?.mode).toBe('chronological');
    expect(await moduleIds(feedId, 'source')).toEqual(['accounts', 'keywords']);
    expect(await moduleIds(feedId, 'filter')).toEqual([
      'languagePreference',
      'noReplies',
      'noBoosts',
      // The owner is not a member, so the legacy implicit owner-exclusion is
      // reproduced as a `muteBlock`.
      'muteBlock',
    ]);
    expect(definition?.sources?.[0].params).toEqual({ authorIds: ['m1', 'm2'] });
    expect(definition?.filters?.[3].params).toEqual({ excludedIds: [owner('a')] });

    // Idempotent: stamping the mode removes the feed from the selection filter,
    // so a second run does not re-migrate it.
    await backfillCustomFeedDefinitions();
    expect(await moduleIds(feedId, 'filter')).toHaveLength(4);
  });

  it('does not exclude the owner when the owner is an explicit member', async () => {
    const feedId = await seedLegacyFeed({
      ownerOxyUserId: owner('b'),
      memberOxyUserIds: [owner('b'), 'm1'],
    });

    await backfillCustomFeedDefinitions();

    expect(await moduleIds(feedId, 'filter')).toEqual([]);
  });

  it('maps includeMedia=false to textOnly', async () => {
    const feedId = await seedLegacyFeed({
      ownerOxyUserId: owner('c'),
      memberOxyUserIds: [owner('c')],
      includeMedia: false,
    });

    await backfillCustomFeedDefinitions();

    expect(await moduleIds(feedId, 'filter')).toEqual(['textOnly']);
  });

  /**
   * The members come from a CHILD TABLE now, not a projected column.
   *
   * Forgetting to load them migrates a member feed into one with no sources at
   * all — which renders empty rather than absent, and the stamped mode means the
   * legacy fallback will never rescue it.
   */
  it('reads members from the join table, not from the feed row', async () => {
    const feedId = await seedLegacyFeed({
      ownerOxyUserId: owner('d'),
      memberOxyUserIds: ['only-member'],
    });

    await backfillCustomFeedDefinitions();

    expect((await storedDefinition(feedId))?.sources?.[0]).toMatchObject({
      module: 'accounts',
      params: { authorIds: ['only-member'] },
    });
  });

  /**
   * THE scoping case. Two legacy feeds, deliberately different definitions.
   *
   * A per-feed update whose `WHERE` is not `id = <this feed>` stamps every
   * un-migrated feed with whichever definition is in hand — both feeds come out
   * identical, every row typechecks, and the run reports success.
   */
  it('gives each feed its own definition rather than one feed\'s to all of them', async () => {
    const keywordFeed = await seedLegacyFeed({
      ownerOxyUserId: owner('e'),
      keywords: ['postgres'],
    });
    const memberFeed = await seedLegacyFeed({
      ownerOxyUserId: owner('f'),
      memberOxyUserIds: ['m9'],
      includeBoosts: false,
    });

    await backfillCustomFeedDefinitions();

    expect(await moduleIds(keywordFeed, 'source')).toEqual(['keywords']);
    expect(await moduleIds(memberFeed, 'source')).toEqual(['accounts']);
    expect(await moduleIds(memberFeed, 'filter')).toEqual(['noBoosts', 'muteBlock']);
  });

  /**
   * The mode and the modules are one commit — ACROSS PAGES.
   *
   * `definitionOf` answers as soon as `definition_mode` is non-null, so a feed
   * carrying a mode with no modules has silently opted out of the legacy
   * fallback and renders empty.
   *
   * `batchSize: 1` is load-bearing, and this test was worthless without it. The
   * failure it guards is an update whose `WHERE` is not `id = <this feed>`:
   * every legacy feed maps to the SAME `chronological` mode, and the modules are
   * written per feed regardless, so within one page a mis-scoped update is
   * invisible. It only bites across pages — the first feed's transaction stamps
   * every REMAINING feed's mode, the next page's `definition_mode IS NULL` query
   * then returns nothing, and those feeds keep a mode with no modules forever.
   * Verified: with one page the mutation passes; with `batchSize: 1` it fails.
   */
  it('never leaves a feed with a stamped mode and no modules, across pages', async () => {
    await seedLegacyFeed({ ownerOxyUserId: owner('g'), keywords: ['a'] });
    await seedLegacyFeed({ ownerOxyUserId: owner('h'), memberOxyUserIds: ['m1'] });
    await seedLegacyFeed({ ownerOxyUserId: owner('j'), keywords: ['c'] });

    await backfillCustomFeedDefinitions({ batchSize: 1 });

    const rows = await getDb()
      .select({ id: customFeeds.id, mode: customFeeds.definitionMode })
      .from(customFeeds)
      .where(like(customFeeds.ownerOxyUserId, `${OWNER_PREFIX}%`));
    expect(rows).toHaveLength(3);

    const modules = await getDb()
      .select({ feedId: customFeedDefinitionModules.feedId })
      .from(customFeedDefinitionModules)
      .where(inArray(customFeedDefinitionModules.feedId, rows.map((row) => row.id)));

    for (const row of rows) {
      expect(row.mode).toBe('chronological');
      expect(modules.some((module) => module.feedId === row.id)).toBe(true);
    }
  });
});

describe('dry run', () => {
  it('reports what it would migrate and writes nothing', async () => {
    const feedId = await seedLegacyFeed({
      ownerOxyUserId: owner('i'),
      keywords: ['nothing-written'],
    });

    const result = await backfillCustomFeedDefinitions({ dryRun: true });

    expect(result.failed).toBe(0);
    expect(result.updated).toBeGreaterThanOrEqual(1);
    const [row] = await getDb()
      .select({ mode: customFeeds.definitionMode })
      .from(customFeeds)
      .where(eq(customFeeds.id, feedId));
    expect(row.mode).toBeNull();
    expect(await moduleIds(feedId, 'source')).toEqual([]);
  });
});
