/**
 * The leader-gated follower-snapshot sweep, against real rows.
 *
 * ## What is actually at stake here
 *
 * The sweep is BOUNDED — it samples at most `FOLLOWER_SNAPSHOT_MAX_AUTHORS`
 * authors per run — so the ORDER it picks them in decides who gets sampled at
 * all. Mongo had no ordering (`Post.distinct(...)` then `.slice(0, MAX)`), which
 * meant that past the cap an arbitrary set of authors was resampled forever and
 * the rest never entered the series at all, silently. The port orders by
 * least-recently-snapshotted, and that makes the NULL ordering load-bearing:
 * Postgres sorts NULLs LAST by default, so a never-snapshotted author — who has
 * no `max(at)` at all — would sink behind every already-sampled author and never
 * be reached. `nulls first` is what lets a new author ever be sampled once.
 *
 * The first block below is that guarantee. It asserts ORDER rather than seeding
 * `MAX_AUTHORS + 1` rows because order is the property; the cap merely consumes
 * it, and an order assertion goes red on the same mutation (`nulls last`) that
 * the expensive version would.
 *
 * The correlated subquery behind that ordering is also the shape that shipped a
 * bug in the sibling oxy-api port: rendered without `qualified()`, its predicate
 * compares a column to itself, `max(at)` collapses to a single global value for
 * every author, and the ordering silently degenerates to the tiebreak.
 * `distinguishes authors by their OWN last snapshot` is the test that catches it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { CachedUserSummary } from '../services/userSummaryCache';

const resolveUserSummaries = vi.fn((_ids: string[]) => Promise.resolve(summaries));
let summaries = new Map<string, CachedUserSummary>();

vi.mock('../services/PostHydrationService', () => ({
  resolveUserSummaries: (ids: string[]) => resolveUserSummaries(ids),
}));

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { authorFollowerSnapshots } from '../db/schema/discovery';
import { posts } from '../db/schema/posts';
import {
  FollowerSnapshotJob,
  followerSnapshotJob,
  FOLLOWER_SNAPSHOT_START_DELAY_MS,
} from '../services/followerSnapshotJob';

let db: Database;
const createdAuthorIds: string[] = [];

/**
 * An author id unique to this run. Every assertion filters the sweep's result
 * down to these, because the suite shares one database with its siblings and the
 * sweep reads the whole `posts` table — a foreign row must not be able to make a
 * test pass or fail.
 */
function authorId(label: string): string {
  const id = `oxy-snapshot-${label}-${randomUUID()}`;
  createdAuthorIds.push(id);
  return id;
}

/** A published, public post inside the 14-day activity window. */
async function seedActivePost(oxyUserId: string): Promise<void> {
  await db.insert(posts).values({
    oxyUserId,
    status: 'published',
    visibility: 'public',
    createdAt: new Date(Date.now() - 60_000),
  });
}

async function seedSnapshot(oxyUserId: string, at: Date, followerCount = 10): Promise<void> {
  await db.insert(authorFollowerSnapshots).values({ oxyUserId, followerCount, at });
}

function summary(followerCount?: number): CachedUserSummary {
  return { user: { id: 'x', username: 'x', name: {} }, followerCount };
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  followerSnapshotJob.stop();
  delete process.env.REDIS_URL;
  summaries = new Map();
  vi.clearAllMocks();
  if (createdAuthorIds.length > 0) {
    await db.delete(authorFollowerSnapshots).where(inArray(authorFollowerSnapshots.oxyUserId, createdAuthorIds));
    await db.delete(posts).where(inArray(posts.oxyUserId, createdAuthorIds));
    createdAuthorIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

/** The authors the sweep asked Oxy about, filtered to the ones this test seeded. */
async function sweptAuthorOrder(): Promise<string[]> {
  await followerSnapshotJob.runSnapshotSweep();
  expect(resolveUserSummaries).toHaveBeenCalledTimes(1);
  const [requested] = resolveUserSummaries.mock.calls[0];
  return requested.filter((id) => createdAuthorIds.includes(id));
}

describe('the bounded sweep reaches a never-snapshotted author FIRST', () => {
  it('orders never-snapshotted authors ahead of already-snapshotted ones', async () => {
    /**
     * THE regression test. Under Postgres's default NULL ordering `fresh` sorts
     * behind every author who has ever been sampled, so once the active-author
     * count passes the cap it is never sampled — and nothing reports that: the
     * sweep succeeds, inserts rows, and logs a healthy count every single time.
     */
    const sampledLongAgo = authorId('long-ago');
    const sampledRecently = authorId('recently');
    const fresh = authorId('fresh');

    for (const id of [sampledLongAgo, sampledRecently, fresh]) await seedActivePost(id);
    await seedSnapshot(sampledLongAgo, new Date('2026-01-01T00:00:00.000Z'));
    await seedSnapshot(sampledRecently, new Date('2026-07-01T00:00:00.000Z'));

    summaries = new Map([
      [sampledLongAgo, summary(1)],
      [sampledRecently, summary(2)],
      [fresh, summary(3)],
    ]);

    expect(await sweptAuthorOrder()).toEqual([fresh, sampledLongAgo, sampledRecently]);
  });

  it('distinguishes authors by their OWN last snapshot, not the table-wide maximum', async () => {
    /**
     * The vacuity floor for the ordering, and the `qualified()` guard. With the
     * correlated reference rendered bare, every author's subquery returns the
     * same global `max(at)`, all three tie, and the order collapses to the
     * `oxy_user_id` tiebreak — which is alphabetical, and deliberately NOT the
     * order this test expects.
     */
    const oldest = `oxy-snapshot-zzz-${randomUUID()}`;
    const middle = `oxy-snapshot-mmm-${randomUUID()}`;
    const newest = `oxy-snapshot-aaa-${randomUUID()}`;
    createdAuthorIds.push(oldest, middle, newest);

    for (const id of [oldest, middle, newest]) await seedActivePost(id);
    await seedSnapshot(oldest, new Date('2026-01-01T00:00:00.000Z'));
    await seedSnapshot(middle, new Date('2026-04-01T00:00:00.000Z'));
    await seedSnapshot(newest, new Date('2026-07-01T00:00:00.000Z'));

    summaries = new Map([[oldest, summary(1)], [middle, summary(2)], [newest, summary(3)]]);

    // Least-recently-sampled first. Sorted by id it would be aaa, mmm, zzz.
    expect(await sweptAuthorOrder()).toEqual([oldest, middle, newest]);
  });

  it("reads each author's LATEST snapshot, not their first", async () => {
    // `max(at)` per author, so an author sampled long ago AND recently counts as
    // recently sampled. A `min` here would invert the pair below.
    const sampledTwice = authorId('twice');
    const sampledOnce = authorId('once');

    for (const id of [sampledTwice, sampledOnce]) await seedActivePost(id);
    await seedSnapshot(sampledTwice, new Date('2026-01-01T00:00:00.000Z'));
    await seedSnapshot(sampledTwice, new Date('2026-07-02T00:00:00.000Z'));
    await seedSnapshot(sampledOnce, new Date('2026-07-01T00:00:00.000Z'));

    summaries = new Map([[sampledTwice, summary(1)], [sampledOnce, summary(2)]]);

    expect(await sweptAuthorOrder()).toEqual([sampledOnce, sampledTwice]);
  });
});

describe('runSnapshotSweep — what it stores', () => {
  it('appends one snapshot per active author that reports a numeric follower count', async () => {
    const withCount = authorId('a');
    const alsoWithCount = authorId('b');
    const withoutCount = authorId('c');

    for (const id of [withCount, alsoWithCount, withoutCount]) await seedActivePost(id);
    summaries = new Map([
      [withCount, summary(100)],
      [alsoWithCount, summary(50)],
      [withoutCount, summary(undefined)],
    ]);

    await followerSnapshotJob.runSnapshotSweep();

    const stored = await db
      .select()
      .from(authorFollowerSnapshots)
      .where(inArray(authorFollowerSnapshots.oxyUserId, createdAuthorIds));

    expect(stored).toHaveLength(2);
    const byAuthor = new Map(stored.map((row) => [row.oxyUserId, row]));
    expect(byAuthor.get(withCount)?.followerCount).toBe(100);
    expect(byAuthor.get(alsoWithCount)?.followerCount).toBe(50);
    expect(byAuthor.get(withCount)?.at).toBeInstanceOf(Date);
    expect(byAuthor.has(withoutCount)).toBe(false);
  });

  it('samples only PUBLIC, PUBLISHED authors inside the activity window', async () => {
    const active = authorId('active');
    const privatePoster = authorId('private');
    const draftPoster = authorId('draft');
    const stalePoster = authorId('stale');

    await seedActivePost(active);
    await db.insert(posts).values({ oxyUserId: privatePoster, status: 'published', visibility: 'private', createdAt: new Date() });
    await db.insert(posts).values({ oxyUserId: draftPoster, status: 'draft', visibility: 'public', createdAt: new Date() });
    await db.insert(posts).values({
      oxyUserId: stalePoster,
      status: 'published',
      visibility: 'public',
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    summaries = new Map(createdAuthorIds.map((id) => [id, summary(7)]));

    expect(await sweptAuthorOrder()).toEqual([active]);
  });

  it('drops a follower count that the column could not hold, rather than losing the whole sweep', async () => {
    /**
     * `follower_count` is `integer` with a `>= 0` CHECK, and one INSERT carries
     * the whole batch — so a single malformed count would abort every author's
     * snapshot. Mongoose's per-document validation under `{ ordered: false }`
     * dropped only the offending author, and that is the behaviour kept.
     */
    const good = authorId('good');
    const negative = authorId('negative');
    const fractional = authorId('fractional');

    for (const id of [good, negative, fractional]) await seedActivePost(id);
    summaries = new Map([
      [good, summary(12)],
      [negative, summary(-1)],
      [fractional, summary(3.5)],
    ]);

    await followerSnapshotJob.runSnapshotSweep();

    const stored = await db
      .select()
      .from(authorFollowerSnapshots)
      .where(inArray(authorFollowerSnapshots.oxyUserId, createdAuthorIds));
    expect(stored.map((row) => row.oxyUserId)).toEqual([good]);
  });

  it('does not insert when there are no active authors', async () => {
    // No posts seeded at all for this test's ids.
    await followerSnapshotJob.runSnapshotSweep();
    const stored = await db
      .select()
      .from(authorFollowerSnapshots)
      .where(inArray(authorFollowerSnapshots.oxyUserId, [authorId('absent')]));
    expect(stored).toEqual([]);
  });

  it('never throws — a failing Oxy resolve is swallowed and stores nothing', async () => {
    const author = authorId('resolve-fails');
    await seedActivePost(author);
    resolveUserSummaries.mockRejectedValueOnce(new Error('oxy down'));

    await expect(followerSnapshotJob.runSnapshotSweep()).resolves.toBeUndefined();

    const stored = await db
      .select()
      .from(authorFollowerSnapshots)
      .where(inArray(authorFollowerSnapshots.oxyUserId, createdAuthorIds));
    expect(stored).toEqual([]);
  });
});

describe('start() scheduling gate', () => {
  it('is an inline no-op when REDIS_URL is unset', () => {
    delete process.env.REDIS_URL;
    vi.useFakeTimers();
    const job = new FollowerSnapshotJob();
    const spy = vi.spyOn(job, 'runSnapshotSweep').mockResolvedValue();
    job.start();
    vi.advanceTimersByTime(FOLLOWER_SNAPSHOT_START_DELAY_MS + 1000);
    expect(spy).not.toHaveBeenCalled();
    job.stop();
    vi.useRealTimers();
  });

  it('defers the first sweep and arms it after the start delay when REDIS_URL is set', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    vi.useFakeTimers();
    const job = new FollowerSnapshotJob();
    const spy = vi.spyOn(job, 'runSnapshotSweep').mockResolvedValue();
    job.start();
    expect(spy).not.toHaveBeenCalled(); // deferred, not immediate
    vi.advanceTimersByTime(FOLLOWER_SNAPSHOT_START_DELAY_MS + 1);
    expect(spy).toHaveBeenCalledTimes(1);
    job.stop();
    vi.useRealTimers();
  });
});
