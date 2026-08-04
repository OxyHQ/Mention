/**
 * WHOSE numbers `/statistics/user` and `/statistics/engagement` answer with —
 * against REAL rows.
 *
 * The rule under test is one boolean — does the caller operate the account named
 * by `?accountId` — so every refusal here is paired with a near-miss that must
 * still succeed. Without both sides, "shown to operators" and "shown to anybody
 * who asks" pass identically: a gate that always allowed would satisfy the
 * operator cases alone, and a gate that always refused would satisfy the stranger
 * cases alone.
 *
 * ## What replaced the old observable, and why it is stronger
 *
 * The suite this supersedes mocked `models/Post.aggregate` and recovered the
 * subject out of the pipeline it was handed —
 * `pipeline[0].$match.authorship.$elemMatch.oxyUserId`. Nothing builds that
 * pipeline any more: the four facets are four drizzle queries joining
 * `post_authorships` on `role = 'owner'`. So the assertion described a store the
 * code had stopped using and would have passed whatever the route answered.
 *
 * The subject is now observed the way a user would notice it being wrong: THE
 * NUMBERS. Each account owns a different quantity of posts with different totals,
 * so "answered with the channel's numbers" cannot be satisfied by the caller's
 * own — which is the exact failure a status-only test misses, since a gate that
 * refused correctly and then fell back to the caller's dashboard is also a 200.
 * It also proves the attribution the route depends on: a channel post's
 * `authorship` OWNER is the channel, so the totals are reachable at all.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  resolveUserSummaries: vi.fn(),
  listAccountMembers: vi.fn(),
}));

// The Redis-cached identity path `publishAsAccount` reads an account's KIND
// through. It answers out of Oxy, which is the one thing this suite cannot have
// for real.
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: mocks.resolveUserSummaries,
  postHydrationService: { hydratePosts: vi.fn(async (rows: object[]) => rows) },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: () => ({ listAccountMembers: mocks.listAccountMembers }),
  createScopedOxyClient: () => ({}),
  getServiceOxyClient: () => ({}),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById: vi.fn(async () => ({})) }),
}));

vi.mock('../../utils/alia', () => ({ aliaChat: vi.fn(), isAliaEnabled: () => false }));

vi.mock('../../services/UserPreferenceService', () => ({
  userPreferenceService: { recordInteraction: vi.fn(async () => undefined) },
}));

vi.mock('../../services/feedViewCounter', () => ({
  recordDedupedView: vi.fn(async () => null),
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { getEngagementRatios, getUserStatistics } from '../../controllers/statistics.controller';

const scope = postScope('statistics-account-subject');

/**
 * Run-unique account ids.
 *
 * The statistics query is scoped to one `oxy_user_id`, so a row left behind by a
 * crashed earlier run under a deterministic id would be counted by this one and
 * every total below would be off by an amount nothing explains.
 */
const run = randomUUID();
const VIEWER = `oxy-viewer-${run}`;
const OPERATED_CHANNEL = `oxy-channel-operated-${run}`;
const OPERATED_BOT = `oxy-bot-operated-${run}`;
const UNOPERATED_ORG = `oxy-org-billing-only-${run}`;
const STRANGER_CHANNEL = `oxy-channel-somebody-elses-${run}`;
const STRANGER_PERSON = `oxy-stranger-person-${run}`;

/**
 * The seeded numbers, per account.
 *
 * DELIBERATELY ALL DIFFERENT, and the vacuity floor below asserts it: if two
 * subjects shared a post count, "answered with the channel's numbers" would be
 * satisfied by the caller's own and the whole file would stop distinguishing the
 * gate it exists to test.
 */
const FIXTURES = {
  [VIEWER]: { postCount: 1, views: 7, likes: 1 },
  [OPERATED_CHANNEL]: { postCount: 3, views: 100, likes: 3 },
  [OPERATED_BOT]: { postCount: 2, views: 40, likes: 5 },
  [STRANGER_CHANNEL]: { postCount: 4, views: 11, likes: 2 },
} as const;

function expectedTotals(accountId: keyof typeof FIXTURES) {
  const fixture = FIXTURES[accountId];
  return {
    posts: fixture.postCount,
    views: fixture.views * fixture.postCount,
    likes: fixture.likes * fixture.postCount,
  };
}

function buildApp(): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'user', { value: { id: VIEWER }, writable: true });
    next();
  });
  app.get('/statistics/user', getUserStatistics);
  app.get('/statistics/engagement', getEngagementRatios);
  return app;
}

/**
 * `queryUserStatistics` memoizes on `<subject>:<days>` for 30s in module scope,
 * and `vi.clearAllMocks()` cannot see it — so two tests asking about the same
 * account over the same window would leave the second one served from the first
 * one's cache, having never run a query. That reads as "the numbers are right"
 * whatever the gate did, so every test is handed its OWN window rather than the
 * default. `requestedStatsDays` clamps to [1, 366], which is why the counter
 * starts at 1 and this file stays well short of 366 tests.
 */
let windowDays = 0;

function query(accountId: string | undefined): string {
  const params = [`days=${windowDays}`];
  if (accountId !== undefined) params.push(`accountId=${encodeURIComponent(accountId)}`);
  return `?${params.join('&')}`;
}

function askStats(accountId?: string) {
  return request(buildApp()).get(`/statistics/user${query(accountId)}`);
}

function askEngagement(accountId?: string) {
  return request(buildApp()).get(`/statistics/engagement${query(accountId)}`);
}

/** Seed one account's posts, with its own view/like numbers on every row. */
async function seedAccount(accountId: keyof typeof FIXTURES): Promise<void> {
  const fixture = FIXTURES[accountId];
  for (let index = 0; index < fixture.postCount; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const record = await seedPost(scope, {
      oxyUserId: accountId,
      authorship: [{ oxyUserId: accountId, role: 'owner', status: 'accepted' }],
      content: { variants: [{ source: 'author', text: `post ${index} ${run}`, tag: 'en' }] },
    });
    // `PostRecordInput` carries no stats — they are counters the engagement paths
    // move — so the fixture sets them the way those paths would have.
    // eslint-disable-next-line no-await-in-loop
    await getDb()
      .update(posts)
      .set({ statsViewsCount: fixture.views, statsLikesCount: fixture.likes })
      .where(eq(posts.id, record.id));
  }
}

beforeAll(async () => {
  await connectPostgres();
  for (const accountId of Object.keys(FIXTURES) as Array<keyof typeof FIXTURES>) {
    await seedAccount(accountId);
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  windowDays += 1;

  mocks.resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const kinds: Record<string, string> = {
      [VIEWER]: 'personal',
      [STRANGER_PERSON]: 'personal',
      [OPERATED_CHANNEL]: 'channel',
      [STRANGER_CHANNEL]: 'channel',
      [OPERATED_BOT]: 'bot',
      [UNOPERATED_ORG]: 'organization',
    };
    const map = new Map<string, { user: { id: string; kind: string } }>();
    for (const id of ids) {
      if (kinds[id]) map.set(id, { user: { id, kind: kinds[id] } });
    }
    return map;
  });

  mocks.listAccountMembers.mockImplementation(async (accountId: string) => {
    if (accountId === OPERATED_CHANNEL) {
      // A channel can never be acted as, so bare ACTIVE membership is the whole
      // right over it — no `account:act_as` here on purpose.
      return [{ memberUserId: VIEWER, status: 'active', permissions: [] }];
    }
    if (accountId === OPERATED_BOT) {
      return [{ memberUserId: VIEWER, status: 'active', permissions: ['account:act_as'] }];
    }
    if (accountId === UNOPERATED_ORG) {
      return [{ memberUserId: VIEWER, status: 'active', permissions: ['billing:read'] }];
    }
    return [];
  });
});

afterAll(async () => {
  await clearPostScope(scope);
  await closePostgres();
});

describe('fixture shape (vacuity floor)', () => {
  it('gives every account a DIFFERENT set of numbers', () => {
    // "Answered with the channel's numbers" is only a claim about the subject
    // while no two subjects agree on what their numbers are.
    const counts = Object.values(FIXTURES).map((fixture) => fixture.postCount);
    expect(new Set(counts).size).toBe(counts.length);
    const totals = Object.values(FIXTURES).map((fixture) => fixture.views * fixture.postCount);
    expect(new Set(totals).size).toBe(totals.length);
  });

  it('stored those numbers on rows the query can actually reach', async () => {
    // The attribution the route depends on: a channel post's `authorship` OWNER
    // is the channel. If that stopped holding, every operator case below would
    // report zeroes and the refusal cases would still pass.
    const response = await askStats(OPERATED_CHANNEL);
    expect(response.body.overview).toMatchObject({
      totalPosts: expectedTotals(OPERATED_CHANNEL).posts,
      totalViews: expectedTotals(OPERATED_CHANNEL).views,
    });
  });
});

describe('GET /statistics/* — an operator reads the account they operate', () => {
  it('answers with the CHANNEL’s numbers, not the caller’s', async () => {
    const response = await askStats(OPERATED_CHANNEL);
    const expected = expectedTotals(OPERATED_CHANNEL);

    expect(response.status).toBe(200);
    expect(response.body.overview.totalPosts).toBe(expected.posts);
    expect(response.body.overview.totalViews).toBe(expected.views);
    expect(response.body.interactions.likes).toBe(expected.likes);
    // The load-bearing half. A gate that allowed the request but kept the caller
    // as the subject would also be a 200, with a plausible dashboard belonging to
    // the wrong account.
    expect(response.body.overview.totalPosts).not.toBe(expectedTotals(VIEWER).posts);
  });

  it('lets a member with `account:act_as` read a BOT', async () => {
    const response = await askStats(OPERATED_BOT);
    const expected = expectedTotals(OPERATED_BOT);

    expect(response.status).toBe(200);
    expect(response.body.overview.totalPosts).toBe(expected.posts);
    expect(response.body.overview.totalViews).toBe(expected.views);
  });

  it('applies the same subject rule to the engagement ratios', async () => {
    const response = await askEngagement(OPERATED_CHANNEL);
    const expected = expectedTotals(OPERATED_CHANNEL);

    expect(response.status).toBe(200);
    expect(response.body.totals).toMatchObject({
      posts: expected.posts,
      views: expected.views,
      likes: expected.likes,
    });
    // Derived from the CHANNEL's totals, so a subject swap moves the ratio too.
    expect(response.body.ratios.likeRate).toBe(
      Number(((expected.likes / expected.views) * 100).toFixed(2)),
    );
  });
});

describe('GET /statistics/* — a non-operator is refused, and gets nobody’s numbers', () => {
  it('refuses a channel the caller does not operate', async () => {
    const response = await askStats(STRANGER_CHANNEL);

    expect(response.status).toBe(403);
    // Never a silent fallback to the caller's own dashboard, and never the
    // stranger's either — the refusal carries no numbers at all.
    expect(response.body.overview).toBeUndefined();
  });

  it('refuses an organization the caller is a member of WITHOUT `account:act_as`', async () => {
    // The near-miss that separates "is a member" from "may act for it". A gate
    // reading bare membership would pass every other case in this file.
    const response = await askStats(UNOPERATED_ORG);

    expect(response.status).toBe(403);
    expect(response.body.overview).toBeUndefined();
  });

  it('refuses another person’s account', async () => {
    const response = await askStats(STRANGER_PERSON);

    expect(response.status).toBe(403);
    expect(response.body.overview).toBeUndefined();
  });

  it('refuses when Oxy cannot say who the members are (fails CLOSED)', async () => {
    // The direction that separates this gate from the protective ones (mute /
    // block / report), which read the same boolean and must ALLOW on an unknown.
    // Reading a private dashboard is a capability, so an unknown withholds it.
    mocks.listAccountMembers.mockRejectedValue(new Error('oxy unreachable'));

    const response = await askStats(OPERATED_CHANNEL);

    expect(response.status).toBe(403);
    expect(response.body.overview).toBeUndefined();
  });

  it('refuses the engagement ratios for the same account', async () => {
    const response = await askEngagement(STRANGER_CHANNEL);

    expect(response.status).toBe(403);
    expect(response.body.totals).toBeUndefined();
  });
});

describe('GET /statistics/* — the viewer’s own numbers still work, and stay free', () => {
  it('answers for the session when no account is named', async () => {
    const response = await askStats();

    expect(response.status).toBe(200);
    expect(response.body.overview.totalPosts).toBe(expectedTotals(VIEWER).posts);
    expect(response.body.overview.totalViews).toBe(expectedTotals(VIEWER).views);
    // The ordinary request must not have acquired an Oxy round trip.
    expect(mocks.listAccountMembers).not.toHaveBeenCalled();
    expect(mocks.resolveUserSummaries).not.toHaveBeenCalled();
  });

  it('treats naming your OWN id as naming none, without a lookup', async () => {
    const response = await askStats(VIEWER);

    expect(response.status).toBe(200);
    expect(response.body.overview.totalPosts).toBe(expectedTotals(VIEWER).posts);
    expect(mocks.listAccountMembers).not.toHaveBeenCalled();
  });

  it('401s an unauthenticated caller before resolving any subject', async () => {
    const app = express();
    app.get('/statistics/user', getUserStatistics);

    const response = await request(app).get(`/statistics/user${query(OPERATED_CHANNEL)}`);

    expect(response.status).toBe(401);
    expect(response.body.overview).toBeUndefined();
    expect(mocks.listAccountMembers).not.toHaveBeenCalled();
  });
});
