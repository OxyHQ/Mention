/**
 * The feed predicates that CHANGED MEANING crossing from Mongo to Postgres,
 * asserted against real rows.
 *
 * Every case here guards a place where the literal translation is silently
 * WRONG — it returns fewer rows rather than an error, which in a feed reads as a
 * ranking change and not as a defect. That is the whole reason this file exists
 * and the reason each case asserts an EXACT id set rather than "something came
 * back": a predicate that drops every unclassified post still returns plenty of
 * rows.
 *
 * Four independent hazards:
 *
 *  1. **`NULL` is not `false`.** Mongo's `$nin` MATCHED a document whose field
 *     was missing; SQL's `NOT IN` evaluates to NULL against a NULL column and
 *     the row is excluded. Same for array overlap: `NULL && ARRAY[…]` is NULL.
 *  2. **The engagement composite is not one expression.** Two of them exist and
 *     they disagree, deliberately (see `socialEngagementScoreSql`).
 *  3. **A generated `geography` point encodes an argument ORDER.** A transposed
 *     lat/lon yields a plausible point in the wrong hemisphere, never an error,
 *     so the assertion has to be an independently checkable real-world distance.
 *  4. **A root feed must not gain a post when a parent is deleted.**
 *     `ON DELETE SET NULL` clears `parent_post_id`; only the stored `is_reply`
 *     keeps the orphan out.
 *
 * The NULL cases write their NULL directly rather than through
 * `insertPostRecord`, which coalesces to `[]`. That is not contrived: the
 * BACKFILL copies Mongo documents verbatim, and a document that never had a
 * hashtag has no `hashtags` key at all — so NULL is what production data
 * actually contains, and the insert path is simply not how it gets there.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import {
  deletePostRecord,
  findPostRecords,
  insertPostRecord,
} from '../../db/posts/postRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { ChronoCursor, chronoCursorSql, chronoOrderBy } from '../../mtn/feed/CursorBuilder';
import { discoverySafeSql, nsfwHashtagExcludeSql } from '../../mtn/feed/feedSafety';
import { authorNotInSql, notABoostSql } from '../../utils/feedQueryBuilder';
import { engagementScoreSql } from '../../mtn/feed/engine/sources/discoverySources';
import { socialEngagementScoreSql } from '../../mtn/feed/engine/sources/socialSources';

let db: Database;
const created: string[] = [];

const AUTHOR = 'oxy-feedpred-author';
const OTHER = 'oxy-feedpred-other';

/**
 * Only rows this suite created — the database is shared with the other suites.
 *
 * `inArray`, never `sql\`${posts.id} = any(${created})\``. That spelling binds
 * the JS array as a ROW CONSTRUCTOR and Postgres answers
 * `op ANY/ALL (array) requires array on right side`. It was written that way
 * here first, which is how the identical mistake was found in
 * `risingCreatorsSource`.
 */
function mine() {
  return inArray(posts.id, created);
}

function baseInput(overrides: Partial<PostRecordInput> = {}): PostRecordInput {
  return {
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'body', tag: 'en' }] },
    ...overrides,
  };
}

async function create(overrides: Partial<PostRecordInput> = {}) {
  const record = await insertPostRecord(baseInput(overrides));
  created.push(record.id);
  return record;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  for (const id of created.splice(0).reverse()) {
    await deletePostRecord(id);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('NULL is not false — the predicates that silently drop rows', () => {
  it('keeps a post whose hashtags column is NULL out of the NSFW exclusion', async () => {
    const noHashtags = await create();
    const cleanHashtags = await create({ hashtags: ['coffee'] });
    const nsfwHashtags = await create({ hashtags: ['nsfw'] });

    // What the backfill produces for a document that never had the field.
    await db.update(posts).set({ hashtags: null }).where(eq(posts.id, noHashtags.id));

    const rows = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(mine(), nsfwHashtagExcludeSql()));

    // The NULL-hashtag post is the one a bare `NOT (hashtags && …)` loses:
    // `NULL && ARRAY[…]` is NULL, and NOT NULL is NULL, which excludes the row.
    expect(rows.map((row) => row.id).sort()).toEqual(
      [noHashtags.id, cleanHashtags.id].sort(),
    );
    expect(rows.map((row) => row.id)).not.toContain(nsfwHashtags.id);
  });

  it('keeps an author-less post when excluding a specific author', async () => {
    const authorless = await create({ oxyUserId: null });
    const byOther = await create({ oxyUserId: OTHER });
    const byExcluded = await create({ oxyUserId: AUTHOR });

    const predicate = authorNotInSql([AUTHOR]);
    expect(predicate).toBeDefined();
    if (!predicate) throw new Error('authorNotInSql returned undefined for a non-empty list');

    const rows = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(mine(), predicate));

    // `oxy_user_id NOT IN ('AUTHOR')` is NULL for the author-less row, so the
    // literal translation drops it. Mongo's `$nin` matched it.
    expect(rows.map((row) => row.id).sort()).toEqual([authorless.id, byOther.id].sort());
    expect(rows.map((row) => row.id)).not.toContain(byExcluded.id);
  });

  it('treats a never-classified post as discovery-safe', async () => {
    // Every sensitivity flag absent — the overwhelmingly common case, and the
    // one a `<> true` translation would drop wholesale.
    const unclassified = await create();
    await db
      .update(posts)
      .set({ classificationSensitive: null, federationSensitive: null, hashtags: null })
      .where(eq(posts.id, unclassified.id));

    const rows = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(mine(), discoverySafeSql()));

    expect(rows.map((row) => row.id)).toEqual([unclassified.id]);
  });
});

describe('the two engagement composites disagree, and that is deliberate', () => {
  /**
   * The tripwire for the divergence recorded on `socialEngagementScoreSql`.
   *
   * `engagementScoreSql` (discovery) splits boosts into native and federated and
   * weights the federated subset at `federatedBoostWeight` (0.5) rather than
   * `boostWeight` (2.5), because a burst of remote Announces used to fake a
   * trending post. `socialEngagementScoreSql` (`topReplies`) does not split.
   *
   * If someone "unifies" them in either direction this goes red and names both
   * functions. Unifying may well be right — but it is a RANKING change and must
   * be made deliberately, not as a side effect of tidying a migration.
   */
  it('scores an all-federated-boost post differently in the two composites', async () => {
    const post = await create();
    await db
      .update(posts)
      .set({
        statsLikesCount: 0,
        statsCommentsCount: 0,
        statsBoostsCount: 10,
        statsFederatedBoostsCount: 10,
      })
      .where(eq(posts.id, post.id));

    const [scores] = await db
      .select({
        discovery: engagementScoreSql(),
        social: socialEngagementScoreSql(),
      })
      .from(posts)
      .where(eq(posts.id, post.id));

    // native = max(0, 10 - 10) = 0 → 0 * 2.5; federated = 10 * 0.5
    expect(scores.discovery).toBe(5);
    // every boost at the native weight: 10 * 2.5
    expect(scores.social).toBe(25);
    expect(scores.discovery).not.toBe(scores.social);
  });

  it('returns the score as a NUMBER, not a numeric string', async () => {
    // The weights are decimal literals, `integer * numeric` is `numeric`, and
    // postgres.js returns `numeric` as a STRING to preserve precision. Without
    // the explicit `::double precision` the score would sort lexicographically
    // in every JS comparison and serialize into the cursor quoted.
    const post = await create();
    await db
      .update(posts)
      .set({ statsLikesCount: 3, statsBoostsCount: 0, statsFederatedBoostsCount: 0, statsCommentsCount: 0 })
      .where(eq(posts.id, post.id));

    const [row] = await db
      .select({ score: engagementScoreSql() })
      .from(posts)
      .where(eq(posts.id, post.id));

    expect(typeof row.score).toBe('number');
    expect(row.score).toBe(3);
  });
});

describe('the generated geography point encodes (longitude, latitude)', () => {
  /**
   * Anchored on a distance anyone can check: Barcelona→Madrid is ~505 km.
   * Transposing the pair yields ~658 km, so this assertion goes red on the exact
   * mistake that is otherwise invisible — a plausible point in the wrong place.
   */
  it('measures Barcelona→Madrid at the real-world distance', async () => {
    const madrid = await create({
      location: { type: 'Point', coordinates: [-3.7038, 40.4168] },
    });

    const [row] = await db
      .select({
        km: sql<number>`(ST_Distance(${posts.geo}, ST_MakePoint(2.1734, 41.3851)::geography) / 1000)::double precision`,
      })
      .from(posts)
      .where(eq(posts.id, madrid.id));

    expect(row.km).toBeGreaterThan(495);
    expect(row.km).toBeLessThan(515);
  });

  it('orders nearer posts first from a reference point', async () => {
    const madrid = await create({
      location: { type: 'Point', coordinates: [-3.7038, 40.4168] },
    });
    const paris = await create({
      location: { type: 'Point', coordinates: [2.3522, 48.8566] },
    });

    // From Barcelona: Madrid (~505 km) before Paris (~830 km).
    const rows = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(mine(), sql`${posts.geo} is not null`))
      .orderBy(sql`${posts.geo} <-> ST_MakePoint(2.1734, 41.3851)::geography`);

    expect(rows.map((row) => row.id)).toEqual([madrid.id, paris.id]);
  });
});

describe('adjacent chronological pages neither overlap nor gap', () => {
  /**
   * The keyset guard, exercised on the case that actually breaks it: rows whose
   * leading sort key TIES.
   *
   * `chronoOrderBy()` is `(created_at DESC, id DESC)`. The id is not decoration
   * — it is what makes the order a strict TOTAL order, and without it two posts
   * sharing a `created_at` have no defined relative position, so page 2 can
   * re-serve a row page 1 already showed and skip one it did not. All six
   * fixtures below share one timestamp deliberately: with the tiebreak removed
   * the union of two pages loses rows, and this test names it.
   *
   * Mutation-tested: deleting `desc(posts.id)` from `chronoOrderBy` turns the
   * "no gap" assertion red.
   */
  it('serves every row exactly once across two pages of tied timestamps', async () => {
    const sharedInstant = new Date('2026-03-01T12:00:00.000Z');
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const record = await create({ createdAt: sharedInstant });
      ids.push(record.id);
    }

    const pageSize = 3;
    const first = await findPostRecords(mine(), {
      orderBy: chronoOrderBy(),
      limit: pageSize,
    });
    expect(first).toHaveLength(pageSize);

    const anchor = first[first.length - 1];
    const keyset = await chronoCursorSql(ChronoCursor.build(anchor.id, anchor.createdAt));
    expect(keyset).toBeDefined();
    if (!keyset) throw new Error('chronoCursorSql returned undefined for a freshly minted cursor');

    const second = await findPostRecords(and(mine(), keyset), {
      orderBy: chronoOrderBy(),
      limit: pageSize,
    });

    const firstIds = first.map((record) => record.id);
    const secondIds = second.map((record) => record.id);

    // No OVERLAP: nothing on page 2 was already on page 1.
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    // No GAP: the two pages together are exactly the fixture set.
    expect([...firstIds, ...secondIds].sort()).toEqual([...ids].sort());
  });
});

describe('an orphaned reply never becomes a root-feed post', () => {
  /**
   * The condition batch 1 attached to shipping `ON DELETE SET NULL`, asserted at
   * the FEED layer rather than the storage layer: it is this query that decides
   * whether the orphan reaches For You / Following / Explore.
   */
  it('keeps a reply out of the root feed after its parent is deleted', async () => {
    const parent = await create();
    const reply = await create({ parentPostId: parent.id });
    const root = await create();

    expect(reply.isReply).toBe(true);

    await deletePostRecord(parent.id);
    created.splice(created.indexOf(parent.id), 1);

    const [orphan] = await db
      .select({ parentPostId: posts.parentPostId, isReply: posts.isReply })
      .from(posts)
      .where(eq(posts.id, reply.id));

    // The parent link is gone — which is exactly why it cannot be the thing the
    // feed reads.
    expect(orphan.parentPostId).toBeNull();
    expect(orphan.isReply).toBe(true);

    const roots = await findPostRecords(
      and(mine(), eq(posts.isReply, false), notABoostSql()),
      { orderBy: [posts.id] },
    );

    expect(roots.map((record) => record.id)).toEqual([root.id]);
  });
});
