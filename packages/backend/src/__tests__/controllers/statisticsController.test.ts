/**
 * `statistics.controller` against REAL Postgres rows — the `$facet` translation.
 *
 * Mongo ran ONE `$match` and four independent sub-pipelines over the matched
 * set. The port runs four queries over the same predicate inside one
 * transaction, and three of its properties are load-bearing enough to have a
 * test that NAMES them when it breaks:
 *
 *  1. **The overview totals are their own query.** `totalPosts` is the size of
 *     the MATCHED SET, never of the returned page — seeded with 12 posts against
 *     a `topPosts` branch capped at 10, so the two differ and reading the total
 *     off that branch is visible. (A `count(*) OVER ()` there would happen to be
 *     right today, because a window aggregate is evaluated before `LIMIT`; it
 *     becomes the silent-zero bug the moment that branch grows an OFFSET, which
 *     is why `routes/customFeeds.routes.ts` — where the offsets already exist —
 *     counts with a second query and has the mutation test for it.)
 *  2. **The date bucket is a WIRE FORMAT.** `{ date: string }` ships to the
 *     client. `to_char(created_at at time zone 'UTC', 'YYYY-MM-DD')` has to
 *     produce byte-identically what Mongo's
 *     `$dateToString {format:'%Y-%m-%d', timezone:'UTC'}` produced, which is the
 *     same thing `Date#toISOString().slice(0,10)` produces — so that is what it
 *     is compared against, rather than a string the test computed the same way
 *     the code does.
 *  3. **`getWeeklySummary` reads the PRIMARY rendition body.** It reaches
 *     `post_content_variants` from a correlated subquery, and a subquery that
 *     silently matched nothing would just drop the snippet from the prompt with
 *     no error anywhere — so the snippet is asserted, not the absence of a
 *     throw. This does NOT gate the `qualified()` call: that statement carries a
 *     join, which makes drizzle qualify every column anyway, so removing
 *     `qualified()` changes no SQL and this test stays green. The call site
 *     records which rendering shape the trap does fire in.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

const { aliaChat, followingIds } = vi.hoisted(() => ({
  aliaChat: vi.fn(async () => 'a summary'),
  followingIds: { value: [] as string[] },
}));

vi.mock('../../utils/alia', () => ({ isAliaEnabled: () => true, aliaChat }));
vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById: async () => ({}) }),
}));
vi.mock('../../services/UserPreferenceService', () => ({
  userPreferenceService: { recordInteraction: vi.fn(async () => undefined) },
}));
vi.mock('../../services/feedViewCounter', () => ({
  recordDedupedView: vi.fn(async () => false),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => undefined),
  getServiceOxyClient: () => ({
    getUserFollowing: async () => ({ following: followingIds.value }),
  }),
}));

import {
  getPostInsights,
  getUserActivity,
  getUserStatistics,
  getWeeklySummary,
  trackPostView,
} from '../../controllers/statistics.controller';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { uuidv7 } from '../../db/schema/columns';
import { posts } from '../../db/schema/posts';
import { postAuthorships, postContentVariants } from '../../db/schema/postContent';
import { userSettings } from '../../db/schema/userProfile';

let db: Database;
const createdPostIds: string[] = [];
const createdSettingsIds: string[] = [];

interface CapturedResponse {
  status: number;
  body: unknown;
}

function makeRes(captured: CapturedResponse) {
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return res;
}

async function call(
  handler: (req: never, res: never) => Promise<unknown>,
  req: Record<string, unknown>,
): Promise<CapturedResponse> {
  const captured: CapturedResponse = { status: 200, body: undefined };
  await handler(req as never, makeRes(captured) as never);
  return captured;
}

interface SeedPostOptions {
  /** Supplied only where the test needs id order to disagree with insert order. */
  id?: string;
  owner?: string;
  createdAt?: Date;
  type?: 'text' | 'image' | 'video' | 'poll' | 'boost' | 'quote';
  visibility?: 'public' | 'followers_only' | 'private';
  status?: 'draft' | 'published' | 'scheduled' | 'restricted';
  views?: number;
  likes?: number;
  replies?: number;
  boosts?: number;
  shares?: number;
  body?: string;
  parentPostId?: string;
  boostOf?: string;
  quoteOf?: string;
}

/**
 * Insert a post plus its OWNER authorship row — the statistics `$match` was
 * `authorship: { $elemMatch: { oxyUserId, role: 'owner' } }`, which is a join
 * now, so a post with no authorship row is invisible to it by construction.
 */
async function seedPost(options: SeedPostOptions = {}): Promise<string> {
  const [post] = await db
    .insert(posts)
    .values({
      ...(options.id === undefined ? {} : { id: options.id }),
      oxyUserId: options.owner ?? null,
      type: options.type ?? 'text',
      visibility: options.visibility ?? 'public',
      status: options.status ?? 'published',
      statsViewsCount: options.views ?? 0,
      statsLikesCount: options.likes ?? 0,
      statsCommentsCount: options.replies ?? 0,
      statsBoostsCount: options.boosts ?? 0,
      statsSharesCount: options.shares ?? 0,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      ...(options.parentPostId === undefined ? {} : { parentPostId: options.parentPostId }),
      ...(options.boostOf === undefined ? {} : { boostOf: options.boostOf }),
      ...(options.quoteOf === undefined ? {} : { quoteOf: options.quoteOf }),
    })
    .returning({ id: posts.id });
  createdPostIds.push(post.id);

  if (options.owner) {
    await db.insert(postAuthorships).values({
      postId: post.id,
      oxyUserId: options.owner,
      role: 'owner',
      status: 'accepted',
    });
  }
  if (options.body !== undefined) {
    await db.insert(postContentVariants).values({
      postId: post.id,
      position: 0,
      source: 'author',
      body: options.body,
    });
  }
  return post.id;
}

function owner(): string {
  return `stats-owner-${randomUUID()}`;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  followingIds.value = [];
  aliaChat.mockClear();
  if (createdPostIds.length > 0) {
    // `posts` self-references cascade/set-null; delete newest first so a reply
    // never outlives the row it points at.
    await db.delete(posts).where(inArray(posts.id, createdPostIds.splice(0)));
  }
  if (createdSettingsIds.length > 0) {
    await db.delete(userSettings).where(inArray(userSettings.id, createdSettingsIds.splice(0)));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /statistics/user — the overview totals', () => {
  it('counts the whole matched set even though topPosts is capped at ten', async () => {
    /**
     * The mutation target: derive `totalPosts` from the `topPosts` branch —
     * `topRows.length` — and it reads 10 here instead of 12.
     */
    const userId = owner();
    for (let index = 0; index < 12; index += 1) {
      await seedPost({ owner: userId, likes: index + 1, views: 10 });
    }

    const res = await call(getUserStatistics, { user: { id: userId }, query: {} });
    const body = res.body as {
      overview: { totalPosts: number; totalViews: number; totalInteractions: number };
      topPosts: Array<{ postId: string; engagement: number }>;
    };

    expect(body.overview.totalPosts).toBe(12);
    expect(body.topPosts).toHaveLength(10);
    // Non-zero on both sides, so a collapsed total cannot pass by accident.
    expect(body.overview.totalViews).toBe(120);
    expect(body.overview.totalInteractions).toBe(78);
  });

  it('returns numbers, not the strings a bigint sum comes back as', async () => {
    // `sum(integer)` widens to `bigint`, which postgres.js hands back as a
    // STRING; `res.json` would ship `"7"` where Mongo shipped `7`.
    const userId = owner();
    await seedPost({ owner: userId, views: 7, likes: 3, replies: 2, boosts: 1, shares: 1 });

    const res = await call(getUserStatistics, { user: { id: userId }, query: {} });
    const body = res.body as {
      overview: { totalViews: number; totalPosts: number };
      interactions: { likes: number; replies: number; boosts: number; shares: number };
    };
    expect(typeof body.overview.totalViews).toBe('number');
    expect(body.overview.totalViews).toBe(7);
    expect(body.interactions).toEqual({ likes: 3, replies: 2, boosts: 1, shares: 1 });
  });

  it('answers zeros — never null — for a user with no posts at all', async () => {
    const res = await call(getUserStatistics, { user: { id: owner() }, query: {} });
    const body = res.body as {
      overview: { totalPosts: number; totalViews: number; engagementRate: number };
      dailyBreakdown: unknown[];
      topPosts: unknown[];
      postsByType: Record<string, number>;
    };
    expect(body.overview).toMatchObject({ totalPosts: 0, totalViews: 0, engagementRate: 0 });
    expect(body.dailyBreakdown).toEqual([]);
    expect(body.topPosts).toEqual([]);
    expect(body.postsByType).toEqual({});
  });

  it('ignores posts the user only COLLABORATES on', async () => {
    const author = owner();
    const collaborator = owner();
    const postId = await seedPost({ owner: author, likes: 5 });
    await db.insert(postAuthorships).values({
      postId,
      oxyUserId: collaborator,
      role: 'collaborator',
      status: 'accepted',
    });

    const res = await call(getUserStatistics, { user: { id: collaborator }, query: {} });
    expect((res.body as { overview: { totalPosts: number } }).overview.totalPosts).toBe(0);
  });
});

describe('the daily breakdown — a wire format, in UTC', () => {
  it('buckets by UTC day in %Y-%m-%d, and sums interactions including shares', async () => {
    const userId = owner();
    // 23:30 UTC and 00:30 UTC the next day: two different UTC days that a
    // local-time bucket would collapse or split differently.
    const lateOnDayOne = new Date(Date.UTC(2026, 4, 10, 23, 30));
    const earlyOnDayTwo = new Date(Date.UTC(2026, 4, 11, 0, 30));
    await seedPost({ owner: userId, createdAt: lateOnDayOne, views: 5, likes: 1, shares: 2 });
    await seedPost({ owner: userId, createdAt: earlyOnDayTwo, views: 3, replies: 4 });

    const res = await call(getUserStatistics, { user: { id: userId }, query: { days: '3650' } });
    const daily = (res.body as { dailyBreakdown: Array<Record<string, number | string>> })
      .dailyBreakdown;

    expect(daily).toEqual([
      {
        date: lateOnDayOne.toISOString().slice(0, 10),
        views: 5,
        likes: 1,
        replies: 0,
        boosts: 0,
        // `shares` fed the sum and was then `$unset` — it must not be emitted,
        // and it must still be counted.
        interactions: 3,
      },
      {
        date: earlyOnDayTwo.toISOString().slice(0, 10),
        views: 3,
        likes: 0,
        replies: 4,
        boosts: 0,
        interactions: 4,
      },
    ]);
    expect(daily[0]).not.toHaveProperty('shares');
  });
});

describe('postsByType', () => {
  it('buckets by type, coalescing an absent type onto text', async () => {
    const userId = owner();
    await seedPost({ owner: userId, type: 'text' });
    await seedPost({ owner: userId, type: 'text' });
    await seedPost({ owner: userId, type: 'image' });
    await seedPost({ owner: userId, type: 'poll' });

    const res = await call(getUserStatistics, { user: { id: userId }, query: {} });
    expect((res.body as { postsByType: Record<string, number> }).postsByType).toEqual({
      image: 1,
      poll: 1,
      text: 2,
    });
  });
});

describe('topPosts', () => {
  it('ranks by engagement and drops shares from the emitted row', async () => {
    const userId = owner();
    const quiet = await seedPost({ owner: userId, likes: 1 });
    const loud = await seedPost({ owner: userId, likes: 5, replies: 5, boosts: 5, shares: 5 });

    const res = await call(getUserStatistics, { user: { id: userId }, query: {} });
    const top = (res.body as { topPosts: Array<Record<string, unknown>> }).topPosts;

    expect(top.map((post) => post.postId)).toEqual([loud, quiet]);
    expect(top[0].engagement).toBe(20);
    expect(top[0]).not.toHaveProperty('shares');
    // `createdAt` is a Date, not the string `db.execute` would have handed back.
    expect(top[0].createdAt).toBeInstanceOf(Date);
  });

  it('breaks a full engagement+createdAt tie by id, so the top ten is reproducible', async () => {
    /**
     * There is no offset here — this is one bounded leaderboard — so the `id`
     * tiebreak is not pagination protection; it is what stops WHICH posts tie
     * into the last slot from being plan-dependent. Mongo left it arbitrary.
     * Ids are SUPPLIED in an order that disagrees with insertion order, because
     * a generated `uuidv7()` is k-sortable and the two would coincide.
     */
    const userId = owner();
    // Inside the default 30-day window, or the `$match` excludes both rows and
    // the assertion below would compare two empty arrays.
    const tied = new Date(Date.now() - 60 * 60 * 1000);
    for (const id of ['222222222222222222222222', '888888888888888888888888']) {
      await seedPost({ id, owner: userId, likes: 3, createdAt: tied });
    }

    const res = await call(getUserStatistics, { user: { id: userId }, query: {} });
    const top = (res.body as { topPosts: Array<{ postId: string }> }).topPosts;
    expect(top.map((post) => post.postId)).toEqual([
      '888888888888888888888888',
      '222222222222222222222222',
    ]);
  });
});

describe('GET /statistics/user/:userId/activity', () => {
  it('counts public published non-boost posts per UTC day', async () => {
    const userId = owner();
    const day = new Date(Date.UTC(2026, 4, 10, 12));
    await seedPost({ owner: userId, createdAt: day });
    await seedPost({ owner: userId, createdAt: day });
    // Excluded: a boost carries no authored content.
    await seedPost({ owner: userId, createdAt: day, type: 'boost' });
    // Excluded: not public, and not published.
    await seedPost({ owner: userId, createdAt: day, visibility: 'private' });
    await seedPost({ owner: userId, createdAt: day, status: 'draft' });

    const res = await call(getUserActivity, {
      params: { userId },
      query: { days: '3650' },
      user: { id: userId },
    });
    expect((res.body as { activity: unknown[] }).activity).toEqual([
      { date: day.toISOString().slice(0, 10), count: 2 },
    ]);
  });

  it('serves an empty set to a non-follower of a private profile, and the real one to a follower', async () => {
    const userId = owner();
    const stranger = owner();
    await seedPost({ owner: userId });
    const [settings] = await db
      .insert(userSettings)
      .values({ oxyUserId: userId, privacyProfileVisibility: 'private' })
      .returning({ id: userSettings.id });
    createdSettingsIds.push(settings.id);

    const denied = await call(getUserActivity, {
      params: { userId },
      query: {},
      user: { id: stranger },
    });
    expect((denied.body as { activity: unknown[] }).activity).toEqual([]);

    followingIds.value = [userId];
    const allowed = await call(getUserActivity, {
      params: { userId },
      query: {},
      user: { id: stranger },
    });
    expect((allowed.body as { activity: unknown[] }).activity).toHaveLength(1);
  });
});

describe('GET /statistics/post/:postId', () => {
  it('counts replies, boosts and quotes with FILTER aggregates over one query', async () => {
    const userId = owner();
    const subject = await seedPost({ owner: userId, views: 100, likes: 4, shares: 1 });
    await seedPost({ owner: userId, parentPostId: subject });
    await seedPost({ owner: userId, parentPostId: subject });
    await seedPost({ owner: userId, type: 'boost', boostOf: subject });
    await seedPost({ owner: userId, type: 'quote', quoteOf: subject });
    await seedPost({ owner: userId, type: 'quote', quoteOf: subject });
    await seedPost({ owner: userId, type: 'quote', quoteOf: subject });
    // A post related to NOTHING must not be counted by any of the three.
    await seedPost({ owner: userId });

    const res = await call(getPostInsights, {
      user: { id: userId },
      params: { postId: subject },
    });
    const body = res.body as {
      postId: string;
      stats: { replies: number; boosts: number; quotes: number; views: number; likes: number };
      engagement: { totalInteractions: number; engagementRate: number; uniqueViewers: null };
      breakdown: { likedBy: number; hasReplies: boolean; hasBoosts: boolean; hasQuotes: boolean };
    };

    expect(body.postId).toBe(subject);
    expect(body.stats).toMatchObject({ replies: 2, boosts: 1, quotes: 3, views: 100, likes: 4 });
    // The counters, not the related rows: likes + comments + boosts + shares.
    expect(body.engagement.totalInteractions).toBe(5);
    expect(body.engagement.engagementRate).toBe(5);
    expect(body.engagement.uniqueViewers).toBeNull();
    expect(body.breakdown).toEqual({
      likedBy: 4,
      hasReplies: true,
      hasBoosts: true,
      hasQuotes: true,
    });
  });

  it('404s an unknown post and 403s someone else\'s', async () => {
    const userId = owner();
    const postId = await seedPost({ owner: userId });

    expect((await call(getPostInsights, { user: { id: userId }, params: { postId: uuidv7() } })).status).toBe(404);
    expect((await call(getPostInsights, { user: { id: owner() }, params: { postId } })).status).toBe(403);
  });
});

describe('POST /statistics/post/:postId/view', () => {
  it('answers the stored view count, and 404s a post that is not there', async () => {
    const userId = owner();
    const postId = await seedPost({ owner: userId, views: 42 });

    const found = await call(trackPostView, { user: { id: userId }, params: { postId } });
    expect(found.body).toEqual({ success: true, viewsCount: 42 });

    const missing = await call(trackPostView, { user: { id: userId }, params: { postId: uuidv7() } });
    expect(missing.status).toBe(404);
  });
});

describe('GET /statistics/weekly-summary', () => {
  it('reaches the PRIMARY rendition body through the correlated subquery', async () => {
    /**
     * `qualified(posts.id)` is what makes the subquery correlate. Drop it and
     * `${posts.id}` renders bare, resolves against `post_content_variants`
     * inside the subquery, and the snippet below is simply absent from the
     * prompt — with no error anywhere.
     */
    const userId = owner();
    const recently = new Date(Date.now() - 60 * 60 * 1000);
    await seedPost({
      owner: userId,
      createdAt: recently,
      likes: 9,
      views: 30,
      body: 'the author own words about tabs',
    });

    const res = await call(getWeeklySummary, { user: { id: userId }, query: {} });
    expect(res.body).toEqual({ summary: 'a summary' });
    expect(aliaChat).toHaveBeenCalledTimes(1);

    const messages = aliaChat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const userMessage = messages.find((message) => message.role === 'user');
    expect(userMessage?.content).toContain('the author own words about tabs');
    expect(userMessage?.content).toContain('This week: 1 posts, 30 views, 9 interactions');
  });

  it('skips the AI call entirely when there was no activity in either week', async () => {
    const res = await call(getWeeklySummary, { user: { id: owner() }, query: {} });
    expect(res.body).toEqual({ summary: null });
    expect(aliaChat).not.toHaveBeenCalled();
  });
});
