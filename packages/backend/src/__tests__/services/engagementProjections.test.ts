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

import { isForeignKeyViolation } from '../../db/pgErrors';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { bookmarks } from '../../db/schema/engagement';
import { postRecentRepliers } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import {
  isRetryableTransactionError,
  reconcileEngagementProjections,
} from '../../services/EngagementProjectionReconciliationService';
import {
  loadRecentReplierIds,
  recordRecentReplierForPost,
  repairRecentRepliersAfterPostDelete,
} from '../../services/PostRecentReplierService';
import { withDeadlockRetry } from '../helpers/serviceFixtures';
import { logger } from '../../utils/logger';

let db: Database;
const createdPostIds: string[] = [];

async function seedPost(values: Partial<typeof posts.$inferInsert> = {}): Promise<string> {
  const [post] = await db
    .insert(posts)
    .values({
      // `posts_reply_discriminator_check` refuses a row that HAS a parent link
      // and claims not to be a reply, so a fixture setting only `parentPostId`
      // is not a post the application could ever have written. A raw insert
      // bypasses the one place that derivation lives (`derivesReplyIntent`, via
      // `postRepository.insertPostRecord`), so the fixture states what the live
      // writer would have derived.
      //
      // The spread comes after, so a case can still pin the flag — and one may
      // need to, because the reverse state is legitimate: `is_reply` with no
      // parent is an ORPHAN, a reply whose parent was deleted (`ON DELETE SET
      // NULL`) or, when federated, never imported.
      isReply: values.parentPostId != null,
      ...values,
    })
    .returning({ id: posts.id });
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

/**
 * The author whose projection write fails ONCE, with a genuinely retryable
 * SQLSTATE, and succeeds on the next attempt.
 *
 * The one-shot part is `nextval`, which is deliberately NON-transactional: the
 * counter it advances survives the rollback the raise causes, so the retried
 * transaction reads `2` and writes normally. Nothing else in Postgres gives a
 * trigger memory across an aborted transaction, and a mocked driver error would
 * only prove `isRetryableProjectionConflict` recognises a shape a test invented.
 */
const PROJECTION_RETRY_PROBE = 'projection-retry-probe';
const RETRY_PROBE_SEQUENCE = 'post_recent_repliers_retry_probe_seq';

beforeAll(async () => {
  db = await connectPostgres();
  await db.execute(sql.raw(`create sequence if not exists ${RETRY_PROBE_SEQUENCE}`));
  // The literals are spliced, not bound: a `$1` inside a function body has no
  // inferable type and Postgres refuses the whole DDL (42P18).
  await db.execute(sql`
    create or replace function post_recent_repliers_failure_probe() returns trigger as $$
    begin
      if new.oxy_user_id = ${sql.raw(`'${PROJECTION_FAILURE_PROBE}'`)} then
        raise exception 'recent replier projection probe';
      end if;
      if new.oxy_user_id = ${sql.raw(`'${PROJECTION_RETRY_PROBE}'`)}
        and nextval(${sql.raw(`'${RETRY_PROBE_SEQUENCE}'`)}) = 1 then
        raise exception 'recent replier projection conflict' using errcode = '40001';
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
    // `post_recent_repliers.post_id` and `bookmarks.post_id` both cascade —
    // which is exactly why this needs the shared retry. `posts` self-references
    // itself four times, so a bulk delete takes locks beyond the rows it names
    // and two suites deleting concurrently deadlock; `withDeadlockRetry` exists
    // for this and every other bulk delete against `posts` already uses it.
    //
    // Unretried, the loser's cleanup throws and its rows SURVIVE — and the red
    // then lands in whichever suite seeds those keys next, naming a constraint
    // (`post_recent_repliers_post_id_oxy_user_id_key`) in a file that did
    // nothing wrong. Observed against `purgeBlockedDomainContent.test.ts`,
    // which reported a `23505` on its own fixture while the deadlock was here.
    await withDeadlockRetry(() => db.delete(posts).where(inArray(posts.id, createdPostIds)));
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

  it('REPORTS the children it deleted, carrying the ids the cascade keys on', async () => {
    /**
     * The return value is the only record that these rows ever existed — the
     * post rows are gone by the time this resolves and no other reader learns
     * of them. `posts.parent_post_id` is `ON DELETE SET NULL`, so the deletion
     * this repair performs is also the LAST moment the parent link is
     * queryable; a caller that re-derived the children afterwards would find
     * none.
     *
     * Both federation URIs are asserted because the cascade's URI-keyed legs
     * read BOTH (`feed_interactions.post_uri`, the two gate tables, and the
     * delivery queue's activity JSON). Dropping either from the projection
     * strands exactly the remote rows nobody would think to look for.
     */
    const parentPostId = await seedPost();
    const federated = await seedPost({
      parentPostId,
      oxyUserId: 'federated-child',
      isReply: true,
      federationActivityId: 'https://remote.example/activities/child-1',
      federationUrl: 'https://remote.example/@someone/child-1',
    });
    const native = await seedPost({
      parentPostId,
      oxyUserId: 'native-child',
      isReply: true,
    });

    const deleted = await repairRecentRepliersAfterPostDelete({ postId: parentPostId });

    // Order is not part of the contract — the cascade consumes the whole set.
    expect([...deleted].sort((left, right) => left.id.localeCompare(right.id))).toEqual(
      [
        {
          id: federated,
          oxyUserId: 'federated-child',
          parentPostId,
          federationActivityId: 'https://remote.example/activities/child-1',
          federationUrl: 'https://remote.example/@someone/child-1',
        },
        {
          id: native,
          oxyUserId: 'native-child',
          parentPostId,
          federationActivityId: null,
          federationUrl: null,
        },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
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
    // An EMPTY list, never a rejection and never a non-empty one: the return
    // value is the cascade's input, so anything else here would send the
    // remaining legs hunting for rows this call never touched.
    await expect(repairRecentRepliersAfterPostDelete({ postId: '   ' })).resolves.toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('RETRIES a transient write conflict instead of leaving the parent stale', async () => {
    /**
     * Without the retry loop this repair is still fail-SOFT — it logs and
     * resolves — so the damage is silent and permanent: the parent keeps an
     * avatar for a replier whose post is gone, and nothing revisits it until
     * the reconciliation sweep happens past. A concurrent reply writer on the
     * same parent is an ordinary event, not a rare one, which is why one
     * serialization failure must not be the end of the attempt.
     *
     * The probe raises `40001` on the FIRST insert only, so a single-attempt
     * implementation gives up here and a retrying one converges.
     */
    await db.execute(sql.raw(`alter sequence ${RETRY_PROBE_SEQUENCE} restart with 1`));
    const parentPostId = await seedPost();
    // `seedPost`, not `reply()` — the latter writes the projection itself and
    // would spend the one-shot failure during setup instead of during the repair.
    await seedPost({
      parentPostId,
      oxyUserId: PROJECTION_RETRY_PROBE,
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
    ).resolves.toEqual([]);

    // Both halves are the claim: the parent ended up correct, AND the service
    // never reported a failure. Asserting only the projection would also pass
    // for an implementation that gave up and happened to have nothing to write.
    expect(await replierIds(parentPostId)).toEqual([PROJECTION_RETRY_PROBE]);
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

    // Empty, not partial: the transaction rolled back, so the children it had
    // deleted are still there. Reporting them would have the cascade clean up
    // after rows that still exist.
    await expect(
      repairRecentRepliersAfterPostDelete({ postId: doomed, parentPostId }),
    ).resolves.toEqual([]);

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

  /**
   * A post deleted between being SELECTED as a candidate and having its
   * projection written is a race the sweep must absorb, and it is not
   * hypothetical: it took down a full suite run here, because the sweep is
   * GLOBAL and every parallel test file is a concurrent post writer and deleter.
   * In production the same window is any user deleting a post, or a moderation
   * enforcement removing one, while the sweep is mid-batch — and absorbing it
   * must NOT widen into absorbing foreign-key failures generally, since a
   * violation on any OTHER relation means the sweep is writing somewhere it
   * should not be.
   *
   * The errors below are REAL driver errors provoked against the live schema,
   * never hand-built objects: the constraint NAME is the load-bearing part of
   * the fix, so a test asserting against a literal it made up itself would pass
   * just as happily with a typo in the service.
   */
  it('retries a projection whose post was deleted mid-sweep, but not any other broken link', async () => {
    const missingPostId = '019fbe00-0000-7000-8000-00000000dead';

    const projectionFk = await db
      .insert(postRecentRepliers)
      .values({ postId: missingPostId, oxyUserId: 'ghost', repliedAt: new Date() })
      .then(() => null)
      .catch((error: unknown) => error);

    // `userId`, not `oxyUserId` — `bookmarks` names that column differently from
    // every other engagement table. Getting it wrong does NOT fail to compile:
    // drizzle's `.values()` ignores a key that is not a column, so the insert
    // simply omitted a NOT NULL field and raised 23502 instead of the 23503 this
    // case is about, and the precondition below is what caught it.
    const bookmarkFk = await db
      .insert(bookmarks)
      .values({ postId: missingPostId, userId: 'ghost' })
      .then(() => null)
      .catch((error: unknown) => error);

    // Both must actually be foreign-key failures, or the assertions below prove
    // nothing about the discrimination between them — an insert that failed for
    // some other reason would make the second one pass for free.
    expect(isForeignKeyViolation(projectionFk)).toBe(true);
    expect(isForeignKeyViolation(bookmarkFk)).toBe(true);

    expect(isRetryableTransactionError(projectionFk)).toBe(true);
    expect(isRetryableTransactionError(bookmarkFk)).toBe(false);
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
