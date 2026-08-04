import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which STORY a post belongs to — the index the feed's diversity pass reads.
 *
 * Everything here is best-effort by design: a post in no story, an empty index
 * and a failed read all mean "no penalty", which is exactly the behaviour before
 * this existed. Diversity is a nicety and must never cost a feed, so the two
 * cases that matter most are the ones about NOT waiting and NOT retrying.
 *
 * Real `trending` rows. The suite this replaces mocked the Mongoose model, so it
 * asserted what a stub had been told to answer — and the read is Postgres now.
 * The two cases about the memo need to count QUERIES, which a row fixture cannot
 * do on its own; they spy on `getDb` and pass it straight through, so the count
 * is of real calls to a real database.
 */

import { inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import * as postgres from '../../db/postgres';
import { trending } from '../../db/schema/discovery';
import {
  getStoryIndex,
  refreshStoryIndex,
  resetStoryIndexCache,
  storyOf,
} from '../../services/trending/storyIndex';

/** Lets a background refresh settle before the assertion reads its result. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Mirrors `INDEX_TTL_MS` in the module under test. */
const INDEX_TTL_MS = 5 * 60 * 1000;

/**
 * Batch stamps in the FUTURE.
 *
 * The index reads the 100 newest rows and then keeps only the newest BATCH, so a
 * row another file wrote concurrently would otherwise decide which batch that is
 * and this suite would read an empty one. Leading the corpus makes "the newest
 * batch is ours" a determinate fact rather than a race.
 */
const NOW = new Date(Date.now() + 3_600_000);
const EARLIER = new Date(Date.now() + 1_800_000);

const seeded: string[] = [];
let seq = 0;

/** One `trending` row in the batch stamped `calculatedAt`. */
async function trend(name: string, terms: string[], calculatedAt: Date): Promise<void> {
  const [row] = await getDb()
    .insert(trending)
    .values({
      type: 'entity',
      name,
      terms,
      score: 1,
      rank: seq++,
      calculatedAt,
    })
    .returning({ id: trending.id });
  seeded.push(row.id);
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  resetStoryIndexCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  const ids = seeded.splice(0);
  if (ids.length > 0) await getDb().delete(trending).where(inArray(trending.id, ids));
});

afterAll(async () => {
  await closePostgres();
});

describe('refreshStoryIndex', () => {
  it('maps every member term of a merged row to the row it belongs to', async () => {
    await trend('ukraine', ['ukraine', 'kyiv', 'zelensky'], NOW);

    await refreshStoryIndex(0);
    const index = getStoryIndex(0);

    expect(index.get('kyiv')).toBe('ukraine');
    expect(index.get('zelensky')).toBe('ukraine');
    expect(index.get('eurovision')).toBeUndefined();
  });

  it('never mixes two batches', async () => {
    // An older batch describes a story that may since have been reshaped.
    // Merging the two would let one term belong to two stories at once.
    await trend('ukraine', ['ukraine', 'kyiv'], NOW);
    await trend('kyiv', ['kyiv', 'zelensky'], EARLIER);

    await refreshStoryIndex(0);
    const index = getStoryIndex(0);

    expect(index.get('kyiv')).toBe('ukraine');
    expect(index.has('zelensky')).toBe(false);
  });

  it('never makes a reader wait — the first read is empty, not pending', async () => {
    await trend('ukraine', ['ukraine', 'kyiv'], NOW);

    // Synchronous by contract. A saturated connection pool QUEUES rather than
    // rejecting, so an awaited read here would hold every feed request open
    // behind it — a ranking refinement becoming an outage. A cold index costs
    // one page its story penalty instead.
    expect(getStoryIndex(0).size).toBe(0);
  });

  it('memoizes an empty index on failure, so a broken database is not retried per request', async () => {
    await trend('ukraine', ['ukraine', 'kyiv'], NOW);
    const failing = vi.spyOn(postgres, 'getDb').mockImplementation(() => {
      throw new Error('postgres down');
    });

    getStoryIndex(0);
    await flush();
    expect(getStoryIndex(1).size).toBe(0);
    await flush();

    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('serves the memo without asking again until it expires', async () => {
    await trend('a', ['a', 'b'], NOW);
    const realGetDb = postgres.getDb;
    const spy = vi.spyOn(postgres, 'getDb').mockImplementation(() => realGetDb());

    // Awaited, not fired-and-forgotten: `getStoryIndex` deliberately does not
    // wait for its own refresh (that is the previous case), so driving the memo
    // through it here would race a real database round trip.
    await refreshStoryIndex(0);
    expect(spy).toHaveBeenCalledTimes(1);
    // And the memo really carries the batch, so the count above is not the count
    // of an index that failed to load and would be rebuilt anyway.
    expect(getStoryIndex(INDEX_TTL_MS - 1).get('b')).toBe('a');

    // Inside the TTL: served from the memo, no second query.
    getStoryIndex(INDEX_TTL_MS - 1);
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);

    // Past it: refreshed.
    getStoryIndex(INDEX_TTL_MS + 1);
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('storyOf', () => {
  const index = new Map([
    ['kyiv', 'ukraine'],
    ['gaza', 'gaza'],
  ]);

  it('takes the FIRST matching term, so one post always lands in one story', () => {
    // A post can touch two stories — a comparison, a thread. Term order is
    // stable for a given post, so this is stable too; a "best match" rule would
    // make the penalty depend on which posts shared a page.
    expect(storyOf(['kyiv', 'gaza'], index)).toBe('ukraine');
    expect(storyOf(['gaza', 'kyiv'], index)).toBe('gaza');
  });

  it('answers null for a post in no story, and for an empty index', () => {
    expect(storyOf(['eurovision'], index)).toBeNull();
    expect(storyOf(undefined, index)).toBeNull();
    expect(storyOf(['kyiv'], new Map())).toBeNull();
  });
});
