import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHOSE numbers `/statistics/user` and `/statistics/engagement` answer with.
 *
 * The rule under test is one boolean — does the caller operate the account named
 * by `?accountId` — so every refusal here is paired with a near-miss that must
 * still succeed. Without both sides, "shown to operators" and "shown to anybody
 * who asks" pass identically: a gate that always allowed would satisfy the
 * operator cases alone, and a gate that always refused would satisfy the stranger
 * cases alone.
 *
 * The assertion that carries the most weight is not the status code but WHICH
 * SUBJECT reached the aggregation. A gate that refused correctly but then fell
 * back to the caller's own numbers would return 200 with a plausible dashboard
 * belonging to the wrong account, and a status-only test would call that a pass.
 * So each case pins the id the query actually ran for.
 */

const {
  postAggregate,
  resolveUserSummaries,
  listAccountMembers,
  userSettingsFindOne,
} = vi.hoisted(() => ({
  postAggregate: vi.fn(),
  resolveUserSummaries: vi.fn(),
  listAccountMembers: vi.fn(),
  userSettingsFindOne: vi.fn(),
}));

vi.mock('../../models/Post', () => {
  const Post = {
    aggregate: postAggregate,
    findById: vi.fn(),
    countDocuments: vi.fn(),
    find: vi.fn(),
  };
  return { default: Post, Post };
});

vi.mock('../../models/UserSettings', () => {
  const UserSettings = { findOne: userSettingsFindOne };
  return { default: UserSettings, UserSettings };
});

vi.mock('../../services/PostHydrationService', () => ({ resolveUserSummaries }));

vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: () => ({ listAccountMembers }),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById: vi.fn().mockResolvedValue({}) }),
}));

vi.mock('../../utils/alia', () => ({
  aliaChat: vi.fn(),
  isAliaEnabled: () => false,
}));

vi.mock('../../services/UserPreferenceService', () => ({
  userPreferenceService: { recordInteraction: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../services/feedViewCounter', () => ({
  recordDedupedView: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { getEngagementRatios, getUserStatistics } from '../../controllers/statistics.controller';

const VIEWER = 'oxy-viewer';
const OPERATED_CHANNEL = 'oxy-channel-operated';
const OPERATED_BOT = 'oxy-bot-operated';
const UNOPERATED_ORG = 'oxy-org-billing-only';
const STRANGER_CHANNEL = 'oxy-channel-somebody-elses';
const STRANGER_PERSON = 'oxy-stranger-person';

/**
 * The aggregation is the only place the SUBJECT becomes observable, so it is read
 * back out of the `$match` rather than trusted from the call arguments' shape.
 */
function subjectsQueried(): string[] {
  return postAggregate.mock.calls.map((call) => {
    const pipeline = call[0] as Array<{ $match?: { authorship?: { $elemMatch?: { oxyUserId?: string } } } }>;
    return pipeline[0]?.$match?.authorship?.$elemMatch?.oxyUserId ?? '';
  });
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
 * one's cache, having never touched the aggregation. That reads as "the query
 * never ran for this subject", which is exactly the failure these tests exist to
 * detect, so every test is handed its OWN window rather than the default.
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

beforeEach(() => {
  vi.clearAllMocks();
  windowDays += 1;
  postAggregate.mockReturnValue({
    option: () => Promise.resolve([
      {
        overview: [{
          totalPosts: 3, totalViews: 300, totalLikes: 9,
          totalReplies: 0, totalBoosts: 0, totalShares: 0,
        }],
        dailyBreakdown: [],
        topPosts: [],
        postsByType: [],
      },
    ]),
  });

  resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const kinds: Record<string, string> = {
      [VIEWER]: 'personal',
      [STRANGER_PERSON]: 'personal',
      [OPERATED_CHANNEL]: 'channel',
      [STRANGER_CHANNEL]: 'channel',
      [OPERATED_BOT]: 'bot',
      [UNOPERATED_ORG]: 'organization',
    };
    const map = new Map();
    for (const id of ids) {
      if (kinds[id]) map.set(id, { user: { id, kind: kinds[id] } });
    }
    return map;
  });

  listAccountMembers.mockImplementation(async (accountId: string) => {
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

describe('GET /statistics/* — an operator reads the account they operate', () => {
  it('answers with the CHANNEL’s numbers, not the caller’s', async () => {
    const response = await askStats(OPERATED_CHANNEL);

    expect(response.status).toBe(200);
    expect(response.body.overview.totalPosts).toBe(3);
    // The load-bearing assertion: the query ran for the channel. A gate that
    // allowed the request but kept the caller as the subject would also be a 200.
    expect(subjectsQueried()).toEqual([OPERATED_CHANNEL]);
  });

  it('lets a member with `account:act_as` read a BOT', async () => {
    const response = await askStats(OPERATED_BOT);

    expect(response.status).toBe(200);
    expect(subjectsQueried()).toEqual([OPERATED_BOT]);
  });

  it('applies the same subject rule to the engagement ratios', async () => {
    const response = await askEngagement(OPERATED_CHANNEL);

    expect(response.status).toBe(200);
    expect(response.body.totals.posts).toBe(3);
    expect(subjectsQueried()).toEqual([OPERATED_CHANNEL]);
  });
});

describe('GET /statistics/* — a non-operator is refused, and gets nobody’s numbers', () => {
  it('refuses a channel the caller does not operate', async () => {
    const response = await askStats(STRANGER_CHANNEL);

    expect(response.status).toBe(403);
    // Never a silent fallback to the caller's own dashboard.
    expect(subjectsQueried()).toEqual([]);
  });

  it('refuses an organization the caller is a member of WITHOUT `account:act_as`', async () => {
    // The near-miss that separates "is a member" from "may act for it". A gate
    // reading bare membership would pass every other case in this file.
    const response = await askStats(UNOPERATED_ORG);

    expect(response.status).toBe(403);
    expect(subjectsQueried()).toEqual([]);
  });

  it('refuses another person’s account', async () => {
    const response = await askStats(STRANGER_PERSON);

    expect(response.status).toBe(403);
    expect(subjectsQueried()).toEqual([]);
  });

  it('refuses when Oxy cannot say who the members are (fails CLOSED)', async () => {
    // The direction that separates this gate from the protective ones (mute /
    // block / report), which read the same boolean and must ALLOW on an unknown.
    // Reading a private dashboard is a capability, so an unknown withholds it.
    listAccountMembers.mockRejectedValue(new Error('oxy unreachable'));

    const response = await askStats(OPERATED_CHANNEL);

    expect(response.status).toBe(403);
    expect(subjectsQueried()).toEqual([]);
  });

  it('refuses the engagement ratios for the same account', async () => {
    const response = await askEngagement(STRANGER_CHANNEL);

    expect(response.status).toBe(403);
    expect(subjectsQueried()).toEqual([]);
  });
});

describe('GET /statistics/* — the viewer’s own numbers still work, and stay free', () => {
  it('answers for the session when no account is named', async () => {
    const response = await askStats();

    expect(response.status).toBe(200);
    expect(subjectsQueried()).toEqual([VIEWER]);
    // The ordinary request must not have acquired an Oxy round trip.
    expect(listAccountMembers).not.toHaveBeenCalled();
    expect(resolveUserSummaries).not.toHaveBeenCalled();
  });

  it('treats naming your OWN id as naming none, without a lookup', async () => {
    const response = await askStats(VIEWER);

    expect(response.status).toBe(200);
    expect(subjectsQueried()).toEqual([VIEWER]);
    expect(listAccountMembers).not.toHaveBeenCalled();
  });

  it('401s an unauthenticated caller before resolving any subject', async () => {
    const app = express();
    app.get('/statistics/user', getUserStatistics);

    const response = await request(app).get(`/statistics/user${query(OPERATED_CHANNEL)}`);

    expect(response.status).toBe(401);
    expect(subjectsQueried()).toEqual([]);
  });
});
