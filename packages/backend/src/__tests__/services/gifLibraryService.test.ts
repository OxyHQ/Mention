/**
 * The owned GIF library, against real rows.
 *
 * Three things are asserted, and only the last is ordinary port coverage.
 *
 * **The ranking.** Mongo's `gif_search_text` index weights `searchTerms` FIVE
 * times `title`. Postgres's default `ts_rank` weights are `{0.1, 0.2, 0.4, 1.0}`
 * and reproduce nothing of the sort — a default-ranked search compiles, runs, and
 * hands back a DIFFERENT order with no error anywhere. The order test below is
 * built from documents the two weightings disagree about, so it is the only thing
 * standing between the picker and a silently re-sorted result list.
 *
 * **The labelling the weights are derived FROM.** `gifs.search_vector` does not
 * carry the A/B labels its own schema docblock claims: `setweight` on an
 * `array_to_tsvector` result is a no-op, because that function emits lexemes with
 * no positions and a weight label lives on a position. `GIF_RANK_WEIGHTS` is
 * derived from what the column ACTUALLY carries (D for terms, B for title), so a
 * test that pins the ordering alone would silently invert if the generated column
 * were ever fixed. The labelling test pins the premise instead, and names the
 * constant when it breaks.
 *
 * **Set semantics on append.** `$addToSet` had no Postgres counterpart and had to
 * be written out; getting it wrong duplicates every term or drops every new one,
 * and nothing fails.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { gifs } from '../../db/schema/discovery';
import {
  getImportedByKlipyIds,
  getLocalTrending,
  importKlipyItem,
  normalizeToTerms,
  recordUse,
  searchLocal,
  type GifRecord,
} from '../../services/gifLibrary/gifLibraryService';

let db: Database;
const createdKlipyIds: string[] = [];

/**
 * A term unique to one test, so a sibling suite's rows can never match it.
 *
 * Kept well under `GIF_TERM_MAX_LEN` (32): `normalizeToTerms` DROPS an over-long
 * token, so a full uuid suffix would make every search here return nothing and
 * every assertion fail for the wrong reason.
 */
function uniqueTerm(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

async function seedGif(overrides: {
  searchTerms?: string[];
  title?: string;
  useCount?: number;
  lastUsedAt?: Date;
}): Promise<GifRecord> {
  const klipyId = `klipy-${randomUUID()}`;
  createdKlipyIds.push(klipyId);
  const [row] = await db
    .insert(gifs)
    .values({
      klipyId,
      slug: klipyId,
      title: overrides.title ?? '',
      searchTerms: overrides.searchTerms ?? [],
      width: 480,
      height: 270,
      mp4FileId: `file-${klipyId}`,
      previewFileId: `preview-${klipyId}`,
      useCount: overrides.useCount ?? 0,
      lastUsedAt: overrides.lastUsedAt ?? new Date('2026-01-01T00:00:00.000Z'),
    })
    .returning();
  return row;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (createdKlipyIds.length > 0) {
    await db.delete(gifs).where(inArray(gifs.klipyId, createdKlipyIds));
    createdKlipyIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('the search vector carries the labels GIF_RANK_WEIGHTS is derived from', () => {
  it('leaves searchTerms lexemes UNLABELLED and labels title lexemes B', async () => {
    /**
     * The premise behind `GIF_RANK_WEIGHTS = {D:1.0, C:0, B:0.2, A:0}`. The
     * schema builds the vector as
     * `setweight(array_to_tsvector(search_terms),'A') || setweight(to_tsvector('simple', title),'B')`,
     * and the first `setweight` does nothing at all — a lexeme with no position
     * has nothing to label, so `ts_rank` scores it as D. If a future schema
     * change gives the terms a real `A` label, this goes red rather than letting
     * the weight array put searchTerms at 0 and invert every result page.
     */
    const term = uniqueTerm('lex');
    const titleWord = uniqueTerm('ttl');
    const gif = await seedGif({ searchTerms: [term], title: titleWord });

    const [row] = await db
      .select({ vector: sql<string>`${gifs.searchVector}::text` })
      .from(gifs)
      .where(eq(gifs.id, gif.id));

    // The terms half: bare lexeme, no `:1A`, no weight at all.
    expect(row.vector).toContain(`'${term}'`);
    expect(row.vector).not.toContain(`'${term}':`);
    // The title half: a real position carrying the B label.
    expect(row.vector).toMatch(new RegExp(`'${titleWord}':\\d+B`));
  });
});

describe('searchLocal ranking — Mongo\'s 5:1 searchTerms:title weighting', () => {
  it('ranks ONE searchTerms hit above THREE title hits', async () => {
    /**
     * THE order test, and the documents are chosen because the two weightings
     * DISAGREE about them. Measured on PostgreSQL 17.5:
     *
     *   correct `{1.0, 0, 0.2, 0}`  →  terms 0.2026 vs title 0.1216  → terms wins
     *   default `{0.1, 0.2, 0.4, 1.0}` → terms 0.2026 vs title 0.2432 → TITLE wins
     *
     * One hit in `searchTerms` must beat three in `title` because Mongo said a
     * searchTerms hit is worth five title hits. A single hit against a single hit
     * would pass under BOTH weightings and prove nothing.
     */
    const alpha = uniqueTerm('alpha');
    const beta = uniqueTerm('beta');
    const gamma = uniqueTerm('gamma');

    const termsHit = await seedGif({ searchTerms: [alpha], title: uniqueTerm('unrelated') });
    const titleHit = await seedGif({
      searchTerms: [uniqueTerm('nomatch')],
      title: `${alpha} ${beta} ${gamma}`,
    });

    const results = await searchLocal(`${alpha} ${beta} ${gamma}`, 10);

    expect(results.map((row) => row.id)).toEqual([termsHit.id, titleHit.id]);
  });

  it('matches on a title term as well as a stored search term', async () => {
    // The vacuity floor for the test above: it must not be passing because the
    // title half of the vector matches nothing in the first place.
    const word = uniqueTerm('solo');
    const titleOnly = await seedGif({ searchTerms: [uniqueTerm('other')], title: word });

    const results = await searchLocal(word, 10);

    expect(results.map((row) => row.id)).toEqual([titleOnly.id]);
  });

  it('breaks a rank tie by useCount, then lastUsedAt, then id', async () => {
    // Three rows whose text relevance is identical by construction, so the whole
    // order comes from the tiebreaks. Without them a `limit` cuts an arbitrary,
    // run-to-run-varying slice of the tie.
    const term = uniqueTerm('tie');
    const cold = await seedGif({ searchTerms: [term], useCount: 1, lastUsedAt: new Date('2026-01-01T00:00:00.000Z') });
    const warm = await seedGif({ searchTerms: [term], useCount: 1, lastUsedAt: new Date('2026-02-01T00:00:00.000Z') });
    const hot = await seedGif({ searchTerms: [term], useCount: 9, lastUsedAt: new Date('2026-01-01T00:00:00.000Z') });

    const results = await searchLocal(term, 10);

    expect(results.map((row) => row.id)).toEqual([hot.id, warm.id, cold.id]);
  });

  it('returns nothing for a query that normalizes to no terms', async () => {
    const term = uniqueTerm('present');
    await seedGif({ searchTerms: [term] });

    // `!!!` survives no token after normalization, so there is no tsquery to run.
    expect(await searchLocal('!!! ???', 10)).toEqual([]);
    expect(normalizeToTerms('!!! ???')).toEqual([]);
  });

  it('matches a query term against a stored term regardless of the query casing', async () => {
    // Both sides go through `normalizeToTerms`, which is what `default_language:
    // 'none'` meant: the stored lexeme is verbatim and the query is cast to
    // `tsquery` with no dictionary, so they can only meet because of that.
    const term = uniqueTerm('case');
    const gif = await seedGif({ searchTerms: [term] });

    const results = await searchLocal(`  ${term.toUpperCase()}!  `, 10);

    expect(results.map((row) => row.id)).toEqual([gif.id]);
  });
});

describe('getLocalTrending', () => {
  it('returns only posted GIFs, most-posted first, with a total order', async () => {
    const marker = uniqueTerm('trend');
    const neverPosted = await seedGif({ searchTerms: [marker], useCount: 0 });
    const oncePosted = await seedGif({ searchTerms: [marker], useCount: 1 });
    const oftenPosted = await seedGif({ searchTerms: [marker], useCount: 7 });

    const results = await getLocalTrending(1000);
    const mine = results.filter((row) => createdKlipyIds.includes(row.klipyId));

    expect(mine.map((row) => row.id)).toEqual([oftenPosted.id, oncePosted.id]);
    expect(mine.map((row) => row.id)).not.toContain(neverPosted.id);
  });
});

describe('getImportedByKlipyIds', () => {
  it('maps provider ids to owned rows and reports exactly the ones present', async () => {
    const present = await seedGif({});
    const map = await getImportedByKlipyIds([present.klipyId, 'klipy-never-imported', '']);

    expect(map.size).toBe(1);
    expect(map.get(present.klipyId)?.id).toBe(present.id);
  });

  it('answers an empty map without querying when given no usable ids', async () => {
    expect(await getImportedByKlipyIds([])).toEqual(new Map());
    expect(await getImportedByKlipyIds(['', ''])).toEqual(new Map());
  });
});

describe('re-surfacing an already-owned GIF appends terms as a SET', () => {
  /**
   * `importKlipyItem` short-circuits on an owned `klipyId` — no download, no
   * upload, straight to the append — so this exercises the real
   * `$addToSet`-replacement without touching the network.
   */
  async function resurface(gif: GifRecord, extra: { title?: string; tags?: string[] }, queryTerm?: string) {
    return importKlipyItem(
      {
        klipyId: gif.klipyId,
        slug: '',
        title: extra.title ?? '',
        mp4Url: 'https://example.invalid/a.mp4',
        previewUrl: 'https://example.invalid/a.mp4',
        width: 1,
        height: 1,
        tags: extra.tags,
      },
      queryTerm,
    );
  }

  it('adds only terms it does not already have, keeps existing order, and counts the hit', async () => {
    const kept = uniqueTerm('kept');
    const also = uniqueTerm('also');
    const fresh = uniqueTerm('fresh');
    const gif = await seedGif({ searchTerms: [kept, also] });

    // `kept` is already stored and must not be appended a second time.
    const updated = await resurface(gif, { tags: [kept, fresh] });

    expect(updated?.searchTerms).toEqual([kept, also, fresh]);
    expect(updated?.searchHitCount).toBe(gif.searchHitCount + 1);
  });

  it('is idempotent on the term set across repeated surfacings', async () => {
    const stored = uniqueTerm('stable');
    const gif = await seedGif({ searchTerms: [stored] });

    await resurface(gif, { tags: [stored] });
    const second = await resurface(gif, { tags: [stored] });

    expect(second?.searchTerms).toEqual([stored]);
    // The hit COUNT still moves — only the set is idempotent.
    expect(second?.searchHitCount).toBe(gif.searchHitCount + 2);
  });

  it('folds the surfacing query term into the set', async () => {
    const stored = uniqueTerm('base');
    const asked = uniqueTerm('asked');
    const gif = await seedGif({ searchTerms: [stored] });

    const updated = await resurface(gif, {}, asked);

    expect(updated?.searchTerms).toEqual([stored, asked]);
    // And the GIF is now findable by what someone actually typed.
    const found = await searchLocal(asked, 10);
    expect(found.map((row) => row.id)).toEqual([gif.id]);
  });
});

describe('recordUse', () => {
  it('increments useCount and stamps lastUsedAt', async () => {
    const gif = await seedGif({ useCount: 4, lastUsedAt: new Date('2020-01-01T00:00:00.000Z') });

    await recordUse(gif.id);

    const [after] = await db.select().from(gifs).where(eq(gifs.id, gif.id));
    expect(after.useCount).toBe(5);
    expect(after.lastUsedAt.getTime()).toBeGreaterThan(gif.lastUsedAt.getTime());
  });

  it('is a silent no-op for an id that names no row, whatever its shape', async () => {
    // The deleted `isValidObjectId` guard's whole job. A text id that matches
    // nothing updates nothing; there is no CastError left to dodge.
    await expect(recordUse('not-an-object-id')).resolves.toBeUndefined();
    await expect(recordUse(randomUUID())).resolves.toBeUndefined();
  });
});
