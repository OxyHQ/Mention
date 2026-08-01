/**
 * The two engagement projections and their repair, against REAL rows:
 * `post_recent_repliers` (incremental writer, post-delete repair) and the
 * reconciliation sweep that re-derives both it and `posts.stats_saves_count`.
 *
 * ## Why one file for three concerns
 *
 * `reconcileEngagementProjections` is GLOBAL — it recomputes every candidate in
 * the database, whoever wrote it. Vitest runs test FILES in parallel, so keeping
 * the sweep in a file of its own meant it interleaved with the incremental
 * writer's own upsert-then-trim and left four rows on a post capped at three.
 * That is not a bug in either one (each converges alone) but a genuine
 * write-write race between two writers of one projection, and it made the
 * cap assertion pass most of the time and fail under load — the worst kind of
 * green. Tests inside a file run sequentially, so co-locating the sweep with the
 * only writer whose rows it can disturb is what makes every assertion below
 * deterministic. Do not split them without giving the sweep another form of
 * isolation.
 *
 * ## What replaced what
 *
 * The three suites this supersedes were mock-based, and each of them asserted a
 * call rather than a row:
 *
 * - `postRecentReplierService.test.ts` reached into
 *   `$let.in.$let.in.$slice[0].$concatArrays[1][0]` to recover the user id a
 *   Mongo aggregation pipeline WOULD have spliced, then re-implemented the merge
 *   inside the mock. `buildRecentReplierUpdatePipeline` and the pure
 *   `mergeRecentRepliers` it checked against are both gone: with a row per
 *   (post, replier) there is no array to splice, so the rules — newest wins per
 *   user, distinct per user, capped at three, newest first — are asserted
 *   against stored rows.
 * - `postRecentReplierDeletion.test.ts` mocked `Post.aggregate` to return a
 *   canned replier list and asserted the service handed that same list back to
 *   the mock. It could not have caught a recompute reading the wrong parent,
 *   excluding the wrong replies, or ordering them backwards.
 * - `EngagementProjectionReconciliationService.test.ts` mocked
 *   `Bookmark.aggregate` to answer `{count: 2}` and asserted `Post.bulkWrite`
 *   was called with `2`. It could not tell a correct correlated count from one
 *   that resolves against the wrong table and silently returns nothing, which is
 *   exactly the failure that shipped in the sibling oxy-api port. Every count
 *   below is an EXACT, NON-ZERO value checked against bookmarks written in the
 *   same test.
 *
 * ## What is deliberately NOT asserted
 *
 * The sweep's batch COUNTS are lower bounds, never equalities: other files hold
 * rows in this database and legitimately add candidates. What is asserted
 * exactly is the state of this suite's own rows.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { bookmarks } from '../../db/schema/engagement';
import { postRecentRepliers } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import { reconcileEngagementProjections } from '../../services/EngagementProjectionReconciliationService';
import {
  loadRecentReplierIds,
  recordRecentReplierForPost,
  repairRecentRepliersAfterPostDelete,
} from '../../services/PostRecentReplierService';
import { logger } from '../../utils/logger';

let db: Database;
const createdPostIds: string[] = [];

async function seedPost(values: Partial<typeof posts.$inferInsert> = {}): Promise<string> {
  const [post] = await db.insert(posts).values(values).returning({ id: posts.id });
  if (!post) throw new Error('Failed to seed a post');
  createdPostIds.push(post.id);
  return post.id;
}

/**
 * A reply as the live paths create one: a real post row FIRST, then the
 * projection write those paths make fire-and-forget.
 *
 * The real post row is not decoration — the sweep re-derives this projection
 * FROM `posts`, so a projection with no backing reply is a row it is entitled to
 * delete, and a test built on one would be asserting against a state the system
 * treats as corrupt.
 */
async function reply(options: {
  parentPostId: string;
  oxyUserId: string;
  createdAt: string;
  visibility?: 'public' | 'followers_only' | 'private';
  status?: 'draft' | 'published' | 'scheduled' | 'restricted';
}): Promise<string> {
  const visibility = options.visibility ?? 'public';
  const status = options.status ?? 'published';
  const id = await seedPost({
    parentPostId: options.parentPostId,
    oxyUserId: options.oxyUserId,
    createdAt: new Date(options.createdAt),
    visibility,
    status,
  });
  await recordRecentReplierForPost({
    parentPostId: options.parentPostId,
    oxyUserId: options.oxyUserId,
    createdAt: options.createdAt,
    visibility,
    status,
  });
  return id;
}

async function storedRepliers(postId: string) {
  return db
    .select({
      oxyUserId: postRecentRepliers.oxyUserId,
      repliedAt: postRecentRepliers.repliedAt,
    })
    .from(postRecentRepliers)
    .where(eq(postRecentRepliers.postId, postId));
}

/** The stored repliers of one post, newest first. */
async function replierIds(postId: string): Promise<string[]> {
  const rows = await storedRepliers(postId);
  return rows
    .sort((left, right) => right.repliedAt.getTime() - left.repliedAt.getTime())
    .map((row) => row.oxyUserId);
}

async function savesCount(postId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ savesCount: posts.statsSavesCount })
    .from(posts)
    .where(eq(posts.id, postId));
  return row?.savesCount;
}

async function postExists(postId: string): Promise<boolean> {
  const rows = await db.select({ id: posts.id }).from(posts).where(eq(posts.id, postId));
  return rows.length === 1;
}

/**
 * The author whose projection row this suite's trigger refuses to write. Scoping
 * the refusal to one user id rather than to the table keeps it invisible to every
 * other suite sharing this database — a projection write is one of the few things
 * a parallel file might genuinely be doing at the same moment.
 */
const PROJECTION_FAILURE_PROBE = 'projection-failure-probe';

beforeAll(async () => {
  db = await connectPostgres();
  // The literal is spliced, not bound: a `$1` inside a function body has no
  // inferable type and Postgres refuses the whole DDL (42P18).
  await db.execute(sql`
    create or replace function post_recent_repliers_failure_probe() returns trigger as $$
    begin
      if new.oxy_user_id = ${sql.raw(`'${PROJECTION_FAILURE_PROBE}'`)} then
        raise exception 'recent replier projection probe';
      end if;
      return new;
    end;
    $$ language plpgsql;
  `);
  await db.execute(sql`
    create or replace trigger post_recent_repliers_failure_probe_trigger
    before insert on post_recent_repliers
    for each row execute function post_recent_repliers_failure_probe();
  `);
});

afterEach(async () => {
  vi.clearAllMocks();
  if (createdPostIds.length > 0) {
    // `post_recent_repliers.post_id` and `bookmarks.post_id` both cascade.
    await db.delete(posts).where(inArray(posts.id, createdPostIds));
    createdPostIds.length = 0;
  }
});

afterAll(async () => {
  await db.execute(
    sql`drop trigger if exists post_recent_repliers_failure_probe_trigger on post_recent_repliers`,
  );
  await db.execute(sql`drop function if exists post_recent_repliers_failure_probe()`);
  await closePostgres();
});

describe('recording a reply', () => {
  it('keeps exactly the three newest DISTINCT repliers, newest first', async () => {
    const parentPostId = await seedPost();

    await reply({ parentPostId, oxyUserId: 'alice', createdAt: '2026-01-01T10:00:00.000Z' });
    await reply({ parentPostId, oxyUserId: 'bob', createdAt: '2026-01-01T09:00:00.000Z' });
    await reply({ parentPostId, oxyUserId: 'alice', createdAt: '2026-01-01T11:00:00.000Z' });
    await reply({ parentPostId, oxyUserId: 'carol', createdAt: '2026-01-01T08:00:00.000Z' });
    await reply({ parentPostId, oxyUserId: 'dave', createdAt: '2026-01-01T10:30:00.000Z' });

    const projection = await loadRecentReplierIds([parentPostId]);

    // alice 11:00, dave 10:30, bob 09:00 — carol (08:00) is squeezed out, and
    // alice appears ONCE at her newest time rather than twice.
    expect(projection.perPostRepliers.get(parentPostId)).toEqual(['alice', 'dave', 'bob']);
    expect([...projection.allReplierIds].sort()).toEqual(['alice', 'bob', 'dave']);
    // The cap is enforced in STORAGE, by the writer's trim, not only on the read.
    expect(await storedRepliers(parentPostId)).toHaveLength(3);
  });

  it('does not let an older out-of-order reply demote a newer one from the same user', async () => {
    /**
     * Backfill and federation import replies in whatever order the remote gave
     * them. `greatest(existing, excluded)` in the upsert is what makes a late
     * 2025 arrival unable to move alice back a year.
     */
    const parentPostId = await seedPost();

    await reply({ parentPostId, oxyUserId: 'alice', createdAt: '2026-01-02T00:00:00.000Z' });
    await reply({ parentPostId, oxyUserId: 'alice', createdAt: '2025-01-02T00:00:00.000Z' });

    expect(await storedRepliers(parentPostId)).toEqual([
      { oxyUserId: 'alice', repliedAt: new Date('2026-01-02T00:00:00.000Z') },
    ]);
  });

  it('excludes private and unpublished replies entirely', async () => {
    const parentPostId = await seedPost();

    await reply({
      parentPostId,
      oxyUserId: 'private-user',
      createdAt: '2026-01-01T10:00:00.000Z',
      visibility: 'private',
    });
    await reply({
      parentPostId,
      oxyUserId: 'scheduled-user',
      createdAt: '2026-01-01T11:00:00.000Z',
      status: 'scheduled',
    });

    expect(await storedRepliers(parentPostId)).toHaveLength(0);
  });

  it('falls back to now when an ingest path hands over an unusable timestamp', async () => {
    /**
     * `createdAt` reaches this from federated and MTN ingest, where it is
     * remote-asserted. An unparseable value must not write an `Invalid Date`
     * into a NOT NULL column and take the whole reply down with it.
     */
    const parentPostId = await seedPost();
    await seedPost({
      parentPostId,
      oxyUserId: 'alice',
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
    });
    const before = Date.now();

    await recordRecentReplierForPost({
      parentPostId,
      oxyUserId: 'alice',
      createdAt: 'not-a-date',
      visibility: 'public',
      status: 'published',
    });

    const [stored] = await storedRepliers(parentPostId);
    expect(stored?.repliedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('ignores a reply with no parent or no author', async () => {
    await recordRecentReplierForPost({ oxyUserId: 'alice', createdAt: new Date() });
    await recordRecentReplierForPost({ parentPostId: 'some-post', createdAt: new Date() });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('fails soft when the parent post is gone', async () => {
    /**
     * The projection must never turn a successful reply into an API failure. A
     * parent that no longer exists is a foreign-key violation, which is the most
     * likely real cause and the easiest to provoke.
     */
    await expect(
      recordRecentReplierForPost({
        parentPostId: '65fdc8c8c8c8c8c8c8c8c8d1',
        oxyUserId: 'alice',
        createdAt: new Date(),
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      '[PostRecentReplier] Failed to update projection',
      expect.objectContaining({ postId: '65fdc8c8c8c8c8c8c8c8c8d1' }),
    );
  });
});

describe('reading the projection', () => {
  it('groups per post and never mixes one post’s repliers into another', async () => {
    const first = await seedPost();
    const second = await seedPost();
    await reply({ parentPostId: first, oxyUserId: 'alice', createdAt: '2026-01-01T10:00:00.000Z' });
    await reply({ parentPostId: second, oxyUserId: 'bob', createdAt: '2026-01-01T10:00:00.000Z' });

    const projection = await loadRecentReplierIds([first, second, 'unknown-post']);

    expect(projection.perPostRepliers.get(first)).toEqual(['alice']);
    expect(projection.perPostRepliers.get(second)).toEqual(['bob']);
    // A post with no repliers is ABSENT rather than mapped to an empty list —
    // the hydration caller distinguishes the two.
    expect(projection.perPostRepliers.has('unknown-post')).toBe(false);
  });

  it('answers an empty request without touching the database', async () => {
    const projection = await loadRecentReplierIds([]);

    expect(projection.perPostRepliers.size).toBe(0);
    expect(projection.allReplierIds.size).toBe(0);
  });

  it('caps the read even if more rows exist than the writer would allow', async () => {
    /**
     * The cap has to hold on BOTH sides. Rows written before this table existed,
     * or by a trim that lost a race, must not widen a feed card's avatar row.
     */
    const parentPostId = await seedPost();
    await db.insert(postRecentRepliers).values([
      { postId: parentPostId, oxyUserId: 'a', repliedAt: new Date('2026-01-01T04:00:00Z') },
      { postId: parentPostId, oxyUserId: 'b', repliedAt: new Date('2026-01-01T03:00:00Z') },
      { postId: parentPostId, oxyUserId: 'c', repliedAt: new Date('2026-01-01T02:00:00Z') },
      { postId: parentPostId, oxyUserId: 'd', repliedAt: new Date('2026-01-01T01:00:00Z') },
    ]);

    const projection = await loadRecentReplierIds([parentPostId]);

    expect(projection.perPostRepliers.get(parentPostId)).toEqual(['a', 'b', 'c']);
    expect(projection.allReplierIds.has('d')).toBe(false);
  });
});

describe('repairing after a reply is deleted', () => {
  it('recomputes the parent from the replies that remain', async () => {
    const parentPostId = await seedPost();
    await reply({ parentPostId, oxyUserId: 'newest', createdAt: '2026-07-26T12:00:00.000Z' });
    await reply({ parentPostId, oxyUserId: 'next', createdAt: '2026-07-26T11:00:00.000Z' });
    const doomed = await reply({
      parentPostId,
      oxyUserId: 'doomed',
      createdAt: '2026-07-26T13:00:00.000Z',
    });
    expect(await replierIds(parentPostId)).toEqual(['doomed', 'newest', 'next']);

    // The authoritative row goes first, exactly as `deletePost` does it.
    await db.delete(posts).where(eq(posts.id, doomed));
    await repairRecentRepliersAfterPostDelete({ postId: doomed, parentPostId });

    expect(await replierIds(parentPostId)).toEqual(['newest', 'next']);
  });

  it('removes the parent projection when the last eligible reply is gone', async () => {
    const parentPostId = await seedPost();
    const only = await reply({
      parentPostId,
      oxyUserId: 'sole',
      createdAt: '2026-07-26T12:00:00.000Z',
    });
    expect(await replierIds(parentPostId)).toEqual(['sole']);

    await db.delete(posts).where(eq(posts.id, only));
    await repairRecentRepliersAfterPostDelete({ postId: only, parentPostId });

    expect(await replierIds(parentPostId)).toEqual([]);
  });

  it('never counts a private reply that outlived the deleted one', async () => {
    /**
     * The recompute reads the SAME eligibility predicate the writer uses. If it
     * drifted, a private reply would surface an avatar on a public feed card the
     * moment a sibling was deleted.
     */
    const parentPostId = await seedPost();
    await reply({
      parentPostId,
      oxyUserId: 'hidden',
      createdAt: '2026-07-26T13:00:00.000Z',
      visibility: 'private',
    });
    const doomed = await reply({
      parentPostId,
      oxyUserId: 'visible',
      createdAt: '2026-07-26T12:00:00.000Z',
    });

    await db.delete(posts).where(eq(posts.id, doomed));
    await repairRecentRepliersAfterPostDelete({ postId: doomed, parentPostId });

    expect(await replierIds(parentPostId)).toEqual([]);
  });
});

describe('repairing after a parent is deleted', () => {
  it('deletes the direct replies and every projection the deletion orphaned', async () => {
    const grandparent = await seedPost();
    const parentPostId = await seedPost({ parentPostId: grandparent, oxyUserId: 'parent-author' });
    const childA = await reply({
      parentPostId,
      oxyUserId: 'child-a',
      createdAt: '2026-07-26T12:00:00.000Z',
    });
    const childB = await reply({
      parentPostId,
      oxyUserId: 'child-b',
      createdAt: '2026-07-26T11:00:00.000Z',
    });
    // The children have replies of their own, so they carry projections too.
    await reply({
      parentPostId: childA,
      oxyUserId: 'grandchild',
      createdAt: '2026-07-26T12:30:00.000Z',
    });

    await repairRecentRepliersAfterPostDelete({ postId: parentPostId, parentPostId: grandparent });

    expect(await postExists(childA)).toBe(false);
    expect(await postExists(childB)).toBe(false);
    expect(await replierIds(parentPostId)).toEqual([]);
    expect(await replierIds(childA)).toEqual([]);
  });

  it('recomputes nothing when the deleted post was a root post', async () => {
    // A root post has no parent to repair, so the repair is purely the removal
    // of what it took with it.
    const rootPostId = await seedPost({ oxyUserId: 'root-author' });
    const child = await reply({
      parentPostId: rootPostId,
      oxyUserId: 'child',
      createdAt: '2026-07-26T12:00:00.000Z',
    });

    await repairRecentRepliersAfterPostDelete({ postId: rootPostId });

    expect(await postExists(child)).toBe(false);
    expect(await replierIds(rootPostId)).toEqual([]);
  });

  it('does nothing at all without a post id', async () => {
    await expect(
      repairRecentRepliersAfterPostDelete({ postId: '   ' }),
    ).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs and resolves rather than failing an already-successful delete', async () => {
    /**
     * The post is gone by the time this runs, so there is nothing left to undo —
     * a rejection here would turn a completed deletion into a 500. The probe
     * trigger supplies a real, non-retryable write failure at exactly the point
     * the repair writes, which is the only way to reach this path without
     * pretending: a parent id that simply names no row does NOT fail, because a
     * recompute that finds no replies writes nothing at all.
     */
    const parentPostId = await seedPost();
    await seedPost({
      parentPostId,
      oxyUserId: PROJECTION_FAILURE_PROBE,
      createdAt: new Date('2026-07-26T12:00:00.000Z'),
    });
    const doomed = await seedPost({
      parentPostId,
      oxyUserId: 'visible',
      createdAt: new Date('2026-07-26T11:00:00.000Z'),
    });
    await db.delete(posts).where(eq(posts.id, doomed));

    await expect(
      repairRecentRepliersAfterPostDelete({ postId: doomed, parentPostId }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      '[PostRecentReplier] Failed to repair projection after post deletion',
      expect.objectContaining({ postId: doomed, parentPostId }),
    );
  });
});

describe('the reconciliation sweep — saves counter', () => {
  it('re-derives an over-count, an under-count and a counter with nothing behind it', async () => {
    const overCounted = await seedPost({ statsSavesCount: 7 });
    const neverCounted = await seedPost({ statsSavesCount: 0 });
    const orphanCounter = await seedPost({ statsSavesCount: 5 });
    await db.insert(bookmarks).values([
      { postId: overCounted, userId: 'viewer-a' },
      { postId: overCounted, userId: 'viewer-b' },
      { postId: overCounted, userId: 'viewer-c' },
      { postId: neverCounted, userId: 'viewer-a' },
      { postId: neverCounted, userId: 'viewer-b' },
    ]);

    const result = await reconcileEngagementProjections();

    // Exact and non-zero: a correlated predicate resolving against the wrong
    // table would answer 0 for all three and only the last would still pass.
    expect(await savesCount(overCounted)).toBe(3);
    expect(await savesCount(neverCounted)).toBe(2);
    expect(await savesCount(orphanCounter)).toBe(0);
    expect(result.saveBatches).toBeGreaterThanOrEqual(1);
  });

  it('repairs every candidate across more pages than one batch holds', async () => {
    /**
     * The keyset cursor, on all FOUR candidate streams at once — stale counters,
     * bookmarked posts, existing projections and replied-to parents — because
     * each pages independently and a cursor bug in any one of them loses a tail
     * of posts silently.
     *
     * Keyset rather than OFFSET, and this test is why: the sweep mutates the very
     * predicate its first stream selects on (`stats_saves_count > 0`), so an
     * offset cursor would step past rows as the result set shrank underneath it.
     * 120 of each is two pages of 100.
     */
    const pageSpill = 120;
    const parents: string[] = [];
    for (let index = 0; index < pageSpill; index += 1) {
      // A parent whose counter is wrong, that somebody bookmarked, and that has
      // one real reply plus a projection row — one row in every stream.
      const parentPostId = await seedPost({ statsSavesCount: 4 });
      parents.push(parentPostId);
      await db.insert(bookmarks).values({ postId: parentPostId, userId: 'viewer-a' });
      await reply({
        parentPostId,
        oxyUserId: `replier-${index}`,
        createdAt: '2026-01-01T10:00:00.000Z',
      });
    }

    await reconcileEngagementProjections();

    const repaired = await db
      .select({ id: posts.id, savesCount: posts.statsSavesCount })
      .from(posts)
      .where(inArray(posts.id, parents));
    expect(repaired).toHaveLength(pageSpill);
    // Exact and non-zero: one bookmark each, so 4 → 1 for every one of them.
    expect(repaired.every((row) => row.savesCount === 1)).toBe(true);

    const projected = await db
      .select({ postId: postRecentRepliers.postId })
      .from(postRecentRepliers)
      .where(inArray(postRecentRepliers.postId, parents));
    expect(projected).toHaveLength(pageSpill);
  }, 60_000);
});

describe('the reconciliation sweep — recent repliers', () => {
  it('rebuilds a projection that was never written', async () => {
    const parentPostId = await seedPost();
    await seedPost({
      parentPostId,
      oxyUserId: 'alice',
      createdAt: new Date('2026-01-01T11:00:00.000Z'),
    });
    await seedPost({
      parentPostId,
      oxyUserId: 'bob',
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
    });

    const result = await reconcileEngagementProjections();

    expect(await replierIds(parentPostId)).toEqual(['alice', 'bob']);
    expect(result.recentReplierBatches).toBeGreaterThanOrEqual(1);
  });

  it('drops an entry whose reply no longer exists', async () => {
    const parentPostId = await seedPost();
    await seedPost({
      parentPostId,
      oxyUserId: 'alice',
      createdAt: new Date('2026-01-01T11:00:00.000Z'),
    });
    await db.insert(postRecentRepliers).values({
      postId: parentPostId,
      oxyUserId: 'ghost',
      repliedAt: new Date('2026-01-01T23:00:00.000Z'),
    });

    await reconcileEngagementProjections();

    expect(await replierIds(parentPostId)).toEqual(['alice']);
  });

  it('deletes a projection whose post has no eligible replies at all', async () => {
    const parentPostId = await seedPost();
    await seedPost({
      parentPostId,
      oxyUserId: 'hidden',
      createdAt: new Date('2026-01-01T11:00:00.000Z'),
      visibility: 'private',
    });
    await db.insert(postRecentRepliers).values({
      postId: parentPostId,
      oxyUserId: 'hidden',
      repliedAt: new Date('2026-01-01T11:00:00.000Z'),
    });

    await reconcileEngagementProjections();

    expect(await replierIds(parentPostId)).toEqual([]);
  });

  it('surfaces a write failure instead of reporting a repair it did not make', async () => {
    /**
     * The sweep is NOT fail-soft, and the distinction from the incremental
     * writer above is the point: a reply that cannot update the projection is a
     * missing avatar, while a RECONCILIATION that quietly gives up leaves the
     * projection wrong and reports success to whoever scheduled it. The probe
     * trigger raises a non-retryable failure, so the retry loop must give up and
     * propagate rather than swallow.
     */
    const parentPostId = await seedPost();
    await seedPost({
      parentPostId,
      oxyUserId: PROJECTION_FAILURE_PROBE,
      createdAt: new Date('2026-01-01T11:00:00.000Z'),
    });

    await expect(reconcileEngagementProjections()).rejects.toThrow();
  });

  it('keeps one entry per author at their newest reply, capped at three', async () => {
    const parentPostId = await seedPost();
    const replies: Array<[string, string]> = [
      ['alice', '2026-01-01T08:00:00.000Z'],
      ['alice', '2026-01-01T12:00:00.000Z'],
      ['bob', '2026-01-01T11:00:00.000Z'],
      ['carol', '2026-01-01T10:00:00.000Z'],
      ['dave', '2026-01-01T09:00:00.000Z'],
    ];
    for (const [oxyUserId, createdAt] of replies) {
      await seedPost({ parentPostId, oxyUserId, createdAt: new Date(createdAt) });
    }

    await reconcileEngagementProjections();

    // alice 12:00, bob 11:00, carol 10:00 — dave falls off, and alice's 08:00
    // reply does not give her a second slot.
    expect(await replierIds(parentPostId)).toEqual(['alice', 'bob', 'carol']);
  });
});
