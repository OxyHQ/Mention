/**
 * The per-author interest score, against real rows.
 *
 * `aggregateAuthors` is the part the port could break silently, and the suite
 * this replaces could not have caught any of it: it mocked `Post.aggregate` and
 * asserted that the `$group` named five fields. What it never asked was what the
 * database gives BACK.
 *
 * That is the whole risk here. postgres.js returns `sum()` and `count()` as
 * STRINGS (`numeric`/`int8` on the wire), so an unmapped column flows into
 * `Math.log1p('42')` and scores every author 0 — a plausible number, no error,
 * and `run()` then pushes a wrong-but-well-formed signal to Oxy. The assertions
 * below are on the numeric VALUES and their types, which is the only observable
 * that can tell the two apart.
 *
 * Redis and the Oxy signals client stay mocked: neither is being ported.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  getRedisClient: vi.fn(),
  hGetAll: vi.fn(),
  hSet: vi.fn(),
  pushInterests: vi.fn(),
}));

vi.mock('../../utils/redis', () => ({ getRedisClient: mocks.getRedisClient }));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { InterestScoreService } from '../../services/InterestScoreService';

const signalsClient = { pushInterests: mocks.pushInterests, pushEndorsements: vi.fn() };

function makeService() {
  return new InterestScoreService(signalsClient as unknown as never);
}

let db: Database;
const createdAuthorIds: string[] = [];

/** An author id unique to this run — the aggregation reads the whole table. */
function authorId(label: string): string {
  const id = `oxy-interest-${label}-${randomUUID()}`;
  createdAuthorIds.push(id);
  return id;
}

interface PostSeed {
  likes?: number;
  boosts?: number;
  comments?: number;
  views?: number;
  shares?: number;
  createdAt?: Date;
  status?: 'published' | 'draft';
  visibility?: 'public' | 'private';
  type?: 'text' | 'boost';
}

async function seedPost(oxyUserId: string | null, seed: PostSeed = {}): Promise<void> {
  await db.insert(posts).values({
    oxyUserId,
    type: seed.type ?? 'text',
    status: seed.status ?? 'published',
    visibility: seed.visibility ?? 'public',
    createdAt: seed.createdAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000),
    statsLikesCount: seed.likes ?? 0,
    statsBoostsCount: seed.boosts ?? 0,
    statsCommentsCount: seed.comments ?? 0,
    statsViewsCount: seed.views ?? 0,
    statsSharesCount: seed.shares ?? 0,
  });
}

/** Only the authors this test seeded — sibling suites write posts too. */
async function aggregateMine(now = Date.now()) {
  const all = await makeService().aggregateAuthors(now);
  return all.filter((row) => createdAuthorIds.includes(row.oxyUserId));
}

/** Redis disabled → no last-pushed history, so every computed score is a delta. */
function resetMocks(): void {
  vi.clearAllMocks();
  mocks.getRedisClient.mockReturnValue({ isReady: false, hGetAll: mocks.hGetAll, hSet: mocks.hSet });
  mocks.pushInterests.mockResolvedValue(undefined);
}

beforeAll(async () => {
  db = await connectPostgres();
  resetMocks();
});

afterEach(async () => {
  resetMocks();
  if (createdAuthorIds.length > 0) {
    await db.delete(posts).where(inArray(posts.oxyUserId, createdAuthorIds));
    createdAuthorIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('aggregateAuthors — the numbers come back as NUMBERS', () => {
  it('sums all five engagement counters across an author\'s posts', async () => {
    const author = authorId('sums');
    await seedPost(author, { likes: 1, boosts: 2, comments: 3, views: 4, shares: 5 });
    await seedPost(author, { likes: 10, views: 20 });

    const [row] = await aggregateMine();

    expect(row.raw).toBe(45);
    expect(row.postCount).toBe(2);
    // The trap: `sum()` and `count()` arrive as strings unless mapped, and
    // `'45'` would satisfy a loose equality while poisoning `Math.log1p`.
    expect(typeof row.raw).toBe('number');
    expect(typeof row.postCount).toBe('number');
    expect(typeof row.lastPostMs).toBe('number');
    expect(Number.isFinite(row.lastPostMs)).toBe(true);
  });

  it('reports the LATEST post time, which is what drives recency decay', async () => {
    const author = authorId('latest');
    const older = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const newer = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await seedPost(author, { createdAt: older });
    await seedPost(author, { createdAt: newer });

    const [row] = await aggregateMine();

    expect(row.lastPostMs).toBe(newer.getTime());
  });

  /**
   * The DATE half of the same trap, and it needs its own test because the two
   * fail in opposite ways.
   *
   * `sum()` returning a string is silent: `Math.log1p('45')` scores an author 0
   * and nothing complains. `max(created_at)` returning a string was silent too,
   * but only because the consumer laundered it — `new Date(r.lastPost)` parses
   * the driver's `'2026-08-15 17:01:48.833+00'` correctly in V8, so the VALUE
   * was right and no assertion on it could ever have distinguished the two.
   *
   * `.mapWith(posts.createdAt)` made it a real `Date`, and the consumer now
   * calls `.getTime()` on it directly. That is what turns the property into
   * something a test can see: delete the `.mapWith` and this throws
   * `r.lastPost.getTime is not a function` — the same shape of 500 that the
   * channel-writers route once shipped — where before it would have passed.
   * `tsc` cannot catch that mutation; the declared type is `Date` either way.
   *
   * Mutation-tested by removing the `.mapWith` and confirming this test, and
   * only this family of tests, goes red.
   */
  it('hands the consumer a real Date, not the driver string that parses like one', async () => {
    const author = authorId('date-shape');
    const at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await seedPost(author, { createdAt: at });

    const [row] = await aggregateMine();

    // Exact, not approximate: a string that reparsed to a DIFFERENT instant
    // would be a second, quieter bug this also refuses.
    expect(row.lastPostMs).toBe(at.getTime());
    expect(new Date(row.lastPostMs).toISOString()).toBe(at.toISOString());
  });

  it('excludes boosts, drafts, private posts, and posts outside the 30-day window', async () => {
    const counted = authorId('counted');
    const boostOnly = authorId('boost-only');
    const draftOnly = authorId('draft-only');
    const privateOnly = authorId('private-only');
    const staleOnly = authorId('stale-only');

    await seedPost(counted, { likes: 7 });
    await seedPost(boostOnly, { likes: 99, type: 'boost' });
    await seedPost(draftOnly, { likes: 99, status: 'draft' });
    await seedPost(privateOnly, { likes: 99, visibility: 'private' });
    await seedPost(staleOnly, { likes: 99, createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) });

    const rows = await aggregateMine();

    expect(rows.map((row) => row.oxyUserId)).toEqual([counted]);
    expect(rows[0].raw).toBe(7);
  });

  it('drops a post with no author rather than grouping them together', async () => {
    // `oxy_user_id` is nullable (the raw federated insert path can omit it), and
    // an author-less group would push a signal for a user that does not exist.
    const author = authorId('has-author');
    await seedPost(author, { likes: 3 });
    await seedPost(null, { likes: 999 });

    const rows = await aggregateMine();

    expect(rows).toHaveLength(1);
    expect(rows[0].raw).toBe(3);
  });

  it('groups per author rather than collapsing them', async () => {
    const first = authorId('first');
    const second = authorId('second');
    await seedPost(first, { likes: 4 });
    await seedPost(second, { likes: 6 });

    const byAuthor = new Map((await aggregateMine()).map((row) => [row.oxyUserId, row.raw]));

    expect(byAuthor.get(first)).toBe(4);
    expect(byAuthor.get(second)).toBe(6);
  });
});

describe('computeScore', () => {
  it('produces a normalized score in [0, 1]', () => {
    const service = makeService();
    const now = 2_000_000_000_000;
    const score = service.computeScore({ oxyUserId: 'a', raw: 100, postCount: 5, lastPostMs: now }, now);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 0 for an author with no posts', () => {
    const service = makeService();
    expect(service.computeScore({ oxyUserId: 'a', raw: 0, postCount: 0, lastPostMs: Date.now() })).toBe(0);
  });

  it('decays the score for older activity', () => {
    const service = makeService();
    const now = 3_000_000_000_000;
    const fresh = service.computeScore({ oxyUserId: 'a', raw: 100, postCount: 5, lastPostMs: now }, now);
    const stale = service.computeScore(
      { oxyUserId: 'a', raw: 100, postCount: 5, lastPostMs: now - 60 * 24 * 60 * 60 * 1000 },
      now,
    );
    expect(stale).toBeLessThan(fresh);
  });
});

describe('run — real rows in, deltas out', () => {
  it('scores every seeded author and pushes a signal in [0, 1] for each', async () => {
    const busy = authorId('busy');
    const quiet = authorId('quiet');
    await seedPost(busy, { likes: 50, views: 200, createdAt: new Date() });
    await seedPost(quiet, { likes: 1, createdAt: new Date() });

    await makeService().run();

    const pushed = mocks.pushInterests.mock.calls
      .flatMap((call) => call[0] as Array<{ userId: string; interestScore: number }>)
      .filter((signal) => createdAuthorIds.includes(signal.userId));

    expect(pushed.map((signal) => signal.userId).sort()).toEqual([busy, quiet].sort());
    for (const signal of pushed) {
      expect(signal.interestScore).toBeGreaterThan(0);
      expect(signal.interestScore).toBeLessThanOrEqual(1);
    }
    // A string `raw` would collapse every score to 0 rather than ordering them.
    const byId = new Map(pushed.map((signal) => [signal.userId, signal.interestScore]));
    expect(byId.get(busy)).toBeGreaterThan(byId.get(quiet) ?? 1);
  });

  it('pushes ONLY the authors whose score moved past epsilon', async () => {
    const unchanged = authorId('unchanged');
    const moved = authorId('moved');
    await seedPost(unchanged, { likes: 50, createdAt: new Date() });
    await seedPost(moved, { likes: 10, createdAt: new Date() });

    const service = makeService();
    const scoredNow = new Date().getTime();
    const aggregates = await service.aggregateAuthors(scoredNow);
    const unchangedScore = service.computeScore(
      aggregates.find((row) => row.oxyUserId === unchanged) ?? {
        oxyUserId: unchanged, raw: 0, postCount: 0, lastPostMs: scoredNow,
      },
      scoredNow,
    );

    mocks.getRedisClient.mockReturnValue({ isReady: true, hGetAll: mocks.hGetAll, hSet: mocks.hSet });
    mocks.hGetAll.mockResolvedValue({ [unchanged]: String(unchangedScore) });
    mocks.hSet.mockResolvedValue(1);

    await service.run(scoredNow);

    const pushedIds = mocks.pushInterests.mock.calls
      .flatMap((call) => call[0] as Array<{ userId: string }>)
      .map((signal) => signal.userId)
      .filter((id) => createdAuthorIds.includes(id));

    expect(pushedIds).toEqual([moved]);
  });
});
