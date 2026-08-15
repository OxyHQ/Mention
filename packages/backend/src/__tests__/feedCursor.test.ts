/**
 * The chronological feed cursor.
 *
 * Two things changed underneath this at the cutover, and each is a silent
 * failure that reads as a product bug rather than an error:
 *
 *  1. **An id is a 24-char ObjectId hex OR a uuid v7, permanently and
 *     simultaneously.** The backfill copies `_id` verbatim, so a post from 2024
 *     keeps its ObjectId forever while everything created after the cutover gets
 *     a uuid. Every id check here used to be `ObjectId.isValid`, which REJECTS a
 *     uuid — so the moment the first post-cutover post anchors a page, the
 *     cursor is discarded and the client is handed page ONE, forever, with
 *     `hasMore: true`. An infinite scroll that never advances. The uuid cases
 *     below are the guard, and they are asserted twice: that the token PARSES,
 *     and that it actually bounds a page of rows.
 *  2. **`id` order is no longer time order.** An ObjectId encoded its creation
 *     time; `text` holding two interleaved id spaces does not. So `id < X` is not
 *     a time bound and `ORDER BY id DESC` is not a time order — a literal
 *     translation of the old id-only branch pages a feed in arbitrary order and
 *     skips rows at every boundary. The fixtures below give the OLDER post the
 *     LARGER id, which is exactly what a federated import produces (remote
 *     `created_at`, locally-minted id), so a surviving id bound goes red rather
 *     than passing by luck.
 *
 * The keyset cases run against real rows because that is the only place the
 * consequence is visible: a wrong bound returns a plausible page, not an error.
 * They are naturally scoped — every predicate is `AND`-ed with this suite's own
 * id set — so the run's shared database cannot leak into them.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, inArray, type SQL } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema';
import { uuidv7 } from '@oxyhq/db';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../db/posts/postRecord';
import { ChronoCursor, chronoCursorSql, chronoOrderBy } from '../mtn/feed/CursorBuilder';

let db: Database;
const created: string[] = [];

const AUTHOR = 'cursor-author';

/** A pre-cutover id: 24 hex characters, exactly as the backfill copied it. */
const OBJECT_ID_HEX = '65fdc8c8c8c8c8c8c8c8c8c8';

async function create(overrides: Partial<PostRecordInput> = {}): Promise<PostRecord> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'body' }] },
    ...overrides,
  });
  created.push(record.id);
  return record;
}

/** Read a page under `keyset`, scoped to this suite's rows, in the feed's order. */
async function page(keyset: SQL | undefined): Promise<string[]> {
  const scope = inArray(posts.id, created);
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(keyset ? and(scope, keyset) : scope)
    .orderBy(...chronoOrderBy());
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  const ids = created.splice(0);
  if (ids.length > 0) await db.delete(posts).where(inArray(posts.id, ids));
});

afterAll(async () => {
  await closePostgres();
});

describe('the cursor token', () => {
  it('round-trips a pre-cutover ObjectId, with and without a timestamp', async () => {
    expect(ChronoCursor.parse(ChronoCursor.build(OBJECT_ID_HEX))).toEqual({ id: OBJECT_ID_HEX });

    const createdAt = new Date('2024-01-01T00:00:00.000Z');
    expect(ChronoCursor.parse(ChronoCursor.build(OBJECT_ID_HEX, createdAt))).toEqual({
      id: OBJECT_ID_HEX,
      ts: createdAt.getTime(),
    });
  });

  /**
   * THE post-cutover case.
   *
   * Mutation: narrow `isLiveEntityId` back to the ObjectId regex and both
   * assertions go red with `undefined` — which in production is not an error but
   * a client pinned to page one for the rest of the session.
   */
  it('accepts a uuid v7, with and without a timestamp', async () => {
    const id = uuidv7();
    expect(ChronoCursor.parse(ChronoCursor.build(id))).toEqual({ id });

    const createdAt = new Date('2026-08-01T00:00:00.000Z');
    expect(ChronoCursor.parse(ChronoCursor.build(id, createdAt))).toEqual({
      id,
      ts: createdAt.getTime(),
    });
  });

  it('refuses a token that is not one of the two live id shapes', async () => {
    // A malformed token must RESET to page one, never become a keyset bound —
    // which is the whole reason the check survives here while it was deleted
    // from the query paths (`@oxyhq/db`).
    expect(ChronoCursor.parse('not-an-id')).toBeUndefined();
    expect(ChronoCursor.parse('1704067200000:not-an-id')).toBeUndefined();
    // Nothing in this schema mints a v4, so a v4 is a client error rather than
    // an id to look up — the version nibble is pinned on purpose.
    expect(ChronoCursor.parse('7c9e6679-7425-40de-944b-e07fc1f90ae7')).toBeUndefined();
    expect(ChronoCursor.parse(undefined)).toBeUndefined();
    expect(ChronoCursor.parse('')).toBeUndefined();
  });
});

describe('the Postgres keyset', () => {
  /**
   * The fixture that makes an id bound observably wrong: `older` carries the
   * LARGEST id and `newest` the smallest, which is what a federated import
   * produces. Under `(created_at DESC, id DESC)` the order is newest → middle →
   * older; under an id order it is exactly reversed.
   */
  async function threeOutOfOrder() {
    const newest = await create({
      id: '000000000000000000000001',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    const middle = await create({
      id: '888888888888888888888888',
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    const older = await create({
      id: 'ffffffffffffffffffffffff',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    return { newest, middle, older };
  }

  it('orders newest-first even when the id order is the exact reverse', async () => {
    const { newest, middle, older } = await threeOutOfOrder();
    expect(await page(undefined)).toEqual([newest.id, middle.id, older.id]);
  });

  it('continues from a timestamped cursor without repeating or skipping', async () => {
    const { newest, middle, older } = await threeOutOfOrder();

    const afterFirst = await chronoCursorSql(ChronoCursor.build(newest.id, newest.createdAt));
    expect(await page(afterFirst)).toEqual([middle.id, older.id]);

    const afterSecond = await chronoCursorSql(ChronoCursor.build(middle.id, middle.createdAt));
    expect(await page(afterSecond)).toEqual([older.id]);

    const afterLast = await chronoCursorSql(ChronoCursor.build(older.id, older.createdAt));
    expect(await page(afterLast)).toEqual([]);
  });

  /**
   * A timestamp-less cursor RECOVERS its missing key rather than being ignored.
   *
   * The two honest options were to discard it — resetting an old client to page
   * one forever — or to look the anchor's `created_at` up. This asserts the
   * recovery produces the SAME page the timestamped form does, which is what
   * makes the choice safe rather than merely different.
   */
  it('recovers the missing timestamp for a legacy id-only cursor', async () => {
    const { newest, middle, older } = await threeOutOfOrder();

    const recovered = await chronoCursorSql(ChronoCursor.build(newest.id));
    expect(await page(recovered)).toEqual([middle.id, older.id]);

    const withTimestamp = await chronoCursorSql(ChronoCursor.build(newest.id, newest.createdAt));
    expect(await page(recovered)).toEqual(await page(withTimestamp));
  });

  /**
   * The same walk anchored on a POST-CUTOVER id, which is the shape every new
   * post has. It is asserted separately from the token test because the two
   * failures are different: the token test catches an id-shape check that
   * rejects the uuid, this catches everything downstream of it — including the
   * anchor lookup, which is a primary-key read that a `uuid` column type would
   * have made a cast error rather than a miss.
   */
  it('pages from a uuid v7 anchor, id-only and timestamped alike', async () => {
    const newest = await create({ createdAt: new Date('2026-03-01T00:00:00.000Z') });
    const older = await create({ createdAt: new Date('2026-01-01T00:00:00.000Z') });
    expect(newest.id).not.toBe(OBJECT_ID_HEX);

    expect(await page(await chronoCursorSql(ChronoCursor.build(newest.id)))).toEqual([older.id]);
    expect(
      await page(await chronoCursorSql(ChronoCursor.build(newest.id, newest.createdAt))),
    ).toEqual([older.id]);
  });

  it('breaks a created_at tie on the id, so a shared instant loses nobody', async () => {
    // Two posts written in the same millisecond is ordinary at scale, and the
    // second key is what keeps the order TOTAL — without it the page boundary
    // falls in an arbitrary place and one of them is served twice or never.
    const sameInstant = new Date('2026-02-01T00:00:00.000Z');
    const higher = await create({ id: 'bbbbbbbbbbbbbbbbbbbbbbbb', createdAt: sameInstant });
    const lower = await create({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', createdAt: sameInstant });

    expect(await page(undefined)).toEqual([higher.id, lower.id]);
    const afterHigher = await chronoCursorSql(ChronoCursor.build(higher.id, sameInstant));
    expect(await page(afterHigher)).toEqual([lower.id]);
  });

  it('falls back to page one when the anchor row is gone', async () => {
    // A deleted anchor cannot bound anything. Returning `undefined` restarts the
    // feed; the alternative — an unsatisfiable bound — is an empty page the
    // client can never page past.
    const anchor = await create({ createdAt: new Date('2026-03-01T00:00:00.000Z') });
    const survivor = await create({ createdAt: new Date('2026-01-01T00:00:00.000Z') });

    await db.delete(posts).where(inArray(posts.id, [anchor.id]));
    expect(await chronoCursorSql(ChronoCursor.build(anchor.id))).toBeUndefined();
    expect(await page(undefined)).toEqual([survivor.id]);
  });

  it('produces no bound at all without a cursor', async () => {
    expect(await chronoCursorSql(undefined)).toBeUndefined();
    expect(await chronoCursorSql('not-an-id')).toBeUndefined();
  });
});

/**
 * The ASCENDING half of the keyset.
 *
 * `applyToQuery`, the Mongo match form this block replaces, is gone with the
 * last Mongoose pager (`connectors/activitypub/routes/ap.routes.ts`). What took
 * its place is a direction: the replies list is the one surface a reader can
 * flip to oldest-first, and the BOUND has to flip with the SORT. A descending
 * bound behind an ascending sort re-serves page one forever — an infinite scroll
 * that never advances, which is precisely the failure the descending cases above
 * are written against, mirrored.
 */
describe('the ascending keyset', () => {
  /** The same scoped page as `page`, read oldest-first. */
  async function pageAscending(cursor?: SQL): Promise<string[]> {
    const scope = inArray(posts.id, created);
    const rows = await db
      .select({ id: posts.id })
      .from(posts)
      .where(cursor ? and(scope, cursor) : scope)
      .orderBy(...chronoOrderBy('asc'));
    return rows.map((row) => row.id);
  }

  it('orders oldest-first and continues forward, never backward', async () => {
    const newest = await create({ createdAt: new Date('2026-03-01T00:00:00.000Z') });
    const middle = await create({ createdAt: new Date('2026-02-01T00:00:00.000Z') });
    const older = await create({ createdAt: new Date('2026-01-01T00:00:00.000Z') });

    expect(await pageAscending(undefined)).toEqual([older.id, middle.id, newest.id]);

    const afterOldest = await chronoCursorSql(ChronoCursor.build(older.id, older.createdAt), 'asc');
    expect(await pageAscending(afterOldest)).toEqual([middle.id, newest.id]);

    const afterMiddle = await chronoCursorSql(ChronoCursor.build(middle.id, middle.createdAt), 'asc');
    expect(await pageAscending(afterMiddle)).toEqual([newest.id]);
  });

  it('a DESCENDING bound behind the ascending sort re-serves what was already read', async () => {
    // The mirror image of the guarantee above, stated as the failure it prevents:
    // pass the descending form of the same cursor and the "next" page contains
    // the rows the reader has already seen instead of the ones after them.
    const newest = await create({ createdAt: new Date('2026-03-01T00:00:00.000Z') });
    const older = await create({ createdAt: new Date('2026-01-01T00:00:00.000Z') });

    const forward = await chronoCursorSql(ChronoCursor.build(older.id, older.createdAt), 'asc');
    const backward = await chronoCursorSql(ChronoCursor.build(older.id, older.createdAt));

    expect(await pageAscending(forward)).toEqual([newest.id]);
    expect(await pageAscending(backward)).toEqual([]);
  });

  it('breaks a created_at tie forward, so a shared instant loses nobody either way', async () => {
    const sameInstant = new Date('2026-02-01T00:00:00.000Z');
    const lower = await create({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', createdAt: sameInstant });
    const higher = await create({ id: 'bbbbbbbbbbbbbbbbbbbbbbbb', createdAt: sameInstant });

    expect(await pageAscending(undefined)).toEqual([lower.id, higher.id]);
    const afterLower = await chronoCursorSql(ChronoCursor.build(lower.id, sameInstant), 'asc');
    expect(await pageAscending(afterLower)).toEqual([higher.id]);
  });
});
