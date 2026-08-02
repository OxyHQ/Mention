/**
 * Route coverage for `GET /hashtags/search` offset pagination, against REAL ROWS.
 *
 * The handler over-fetches one row past `limit` to detect `hasMore` and pages
 * with a stable `{ count desc, tag asc }` sort. The previous version mocked the
 * aggregation and re-implemented `$skip`/`$limit` in the mock, so it asserted
 * that the handler had BUILT a pipeline — it could not distinguish the real
 * `GROUP BY` over `unnest(hashtags)` from one that returns nothing, and it could
 * not see the tie-break at all, because the mock handed back an already-ranked
 * list. The tie-break is the reason offset paging is safe here: two tags with
 * equal counts and no deterministic second key can swap between pages, which
 * shows up as a repeated or a skipped tag and never as an error.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import hashtagsRoutes from '../../routes/hashtags';

const app = express();
app.use(express.json());
app.use('/hashtags', hashtagsRoutes);

const scope = postScope('hashtag-search');

/**
 * A tag unique to this file, since one database serves the whole parallel run
 * and the handler ranks across every public post in it. The prefix is what keeps
 * another suite's `#test` out of these pages.
 */
const PREFIX = 'hstagfixture';

/** Zero-padded, so alphabetical order and numeric order agree past nine. */
function pad(index: number): string {
  return String(index).padStart(2, '0');
}

describe('GET /hashtags/search — pagination', () => {
  beforeAll(async () => {
    await connectPostgres();
  });

  afterEach(async () => {
    await clearPostScope(scope);
  });

  afterAll(async () => {
    await closePostgres();
  });

  /**
   * `counts[i]` posts carrying `<PREFIX>i`, so the ranking is known exactly.
   *
   * Inserted in DESCENDING tag order on purpose. With equal counts, a query
   * whose sort has no tie-break returns whatever order the scan produced —
   * which is insertion order — so seeding alphabetically would let a missing
   * `tag asc` produce the right answer by accident. Verified: dropping the
   * tie-break passes when these are inserted in order and fails when they are
   * not.
   */
  async function seedTags(counts: number[]): Promise<void> {
    for (let index = counts.length - 1; index >= 0; index -= 1) {
      for (let n = 0; n < counts[index]; n += 1) {
        await seedPost(scope, { hashtags: [`${PREFIX}${pad(index)}`] });
      }
    }
  }

  async function page(query: Record<string, string | number>) {
    const res = await request(app).get('/hashtags/search').query(query).expect(200);
    return {
      tags: (res.body.hashtags as Array<{ tag: string }>).map((row) => row.tag),
      counts: (res.body.hashtags as Array<{ count: number }>).map((row) => row.count),
      pagination: res.body.pagination as { offset: number; limit: number; hasMore: boolean },
    };
  }

  it('rejects a missing query with 400', async () => {
    await request(app).get('/hashtags/search').expect(400);
  });

  it('ranks by post count and reports the real count per tag', async () => {
    await seedTags([3, 1, 2]);

    const { tags, counts } = await page({ query: PREFIX, limit: 10 });

    expect(tags).toEqual([`${PREFIX}00`, `${PREFIX}02`, `${PREFIX}01`]);
    expect(counts).toEqual([3, 2, 1]);
  });

  it('over-fetches to report hasMore and returns exactly `limit` rows on a full page', async () => {
    await seedTags([3, 2, 1]);

    const { tags, pagination } = await page({ query: PREFIX, limit: 2, offset: 0 });

    expect(tags).toEqual([`${PREFIX}00`, `${PREFIX}01`]);
    expect(pagination).toMatchObject({ offset: 0, limit: 2, hasMore: true });
  });

  it('pages with a stable order and never repeats or skips a tag', async () => {
    // Every count is EQUAL, so the count sort alone cannot order these — only
    // the `tag asc` tie-break can. Distinct counts would make this test pass
    // against a handler with no tie-break at all.
    //
    // TWELVE of them, not five: with a handful of groups Postgres returns them
    // in an order that happens to be alphabetical anyway, so dropping the
    // tie-break passed this test at five tags. Enough groups to make the
    // aggregate's output order genuinely arbitrary is what gives the assertion
    // something to catch — verified by re-running the mutation at both sizes.
    const TAGS = 12;
    await seedTags(Array.from({ length: TAGS }, () => 1));
    const expected = Array.from({ length: TAGS }, (_, index) => `${PREFIX}${pad(index)}`);

    const seen: string[] = [];
    let offset = 0;
    let guard = 0;

    for (;;) {
      const { tags, pagination } = await page({ query: PREFIX, limit: 2, offset });
      seen.push(...tags);
      if (!pagination.hasMore) break;
      offset = pagination.offset + pagination.limit;
      if ((guard += 1) > 10) throw new Error('pagination did not terminate');
    }

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('reports hasMore=false when the result set fits within the default page', async () => {
    await seedTags([2, 1]);

    const { tags, pagination } = await page({ query: PREFIX });

    expect(tags).toHaveLength(2);
    expect(pagination.hasMore).toBe(false);
  });

  it('never ranks a hashtag that only appears on a non-public post', async () => {
    await seedPost(scope, { hashtags: [`${PREFIX}public`] });
    await seedPost(scope, { hashtags: [`${PREFIX}private`], visibility: 'private' });

    const { tags } = await page({ query: PREFIX, limit: 10 });

    expect(tags).toEqual([`${PREFIX}public`]);
  });
});
