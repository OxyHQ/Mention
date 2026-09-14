import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * `feed.controller.ts` wires the FeedTuner's `hideSensitive` preference from the
 * viewer's OWN stored sensitive-content opt-in (`context.showSensitiveContent`,
 * already resolved this request by `loadViewerFeedContext` from
 * `userSettings.privacy.showSensitiveContent`) — `hideSensitive: !context.showSensitiveContent`
 * — instead of the previous hardcoded `false`, which meant `filterSensitiveContent`
 * could never trigger regardless of what the viewer preferred.
 *
 * The engine (and its own unconditional `safety` pool filter) is mocked here so
 * the response can carry a sensitive post straight into `response.slices`, which
 * is the only way to observe the tuner's OWN behavior in isolation from the
 * engine-level filter that already exists for every real feed definition.
 */

const engineRun = vi.fn();
vi.mock('../mtn/feed/engine/FeedEngine', () => ({
  feedEngine: { run: (...args: unknown[]) => engineRun(...args), peekLatest: vi.fn(async () => undefined) },
}));

vi.mock('../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getBlockedUsers: vi.fn(async () => []),
    getRestrictedUsers: vi.fn(async () => []),
    getUserFollowing: vi.fn(async () => ({ data: [] })),
    getUserFollowers: vi.fn(async () => ({ data: [] })),
  }),
}));
vi.mock('../mtn/UserPrivacyManager', () => ({
  UserPrivacyManager: {
    loadPrivacyState: vi.fn(async () => ({
      blockedUserIds: new Set<string>(),
      mutedUserIds: new Set<string>(),
      restrictedUserIds: new Set<string>(),
      excludedUserIds: new Set<string>(),
    })),
  },
}));
vi.mock('../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn((_req?: unknown): unknown => undefined),
}));
vi.mock('../services/ListSubscriptionService', () => ({
  listSubscriptionService: { getSubscribedListMemberIds: vi.fn(async () => []) },
}));
vi.mock('../services/laneVisibility', () => ({
  ownerHasProfileAffectingLane: vi.fn(async () => false),
}));
vi.mock('../services/UserPreferenceService', () => ({
  userPreferenceService: { getUserBehavior: vi.fn(async () => undefined), getTopRegion: vi.fn(() => undefined) },
}));
vi.mock('../services/anonFeedCache', () => ({
  anonFeedCache: {
    read: vi.fn(async () => null),
    write: vi.fn(async () => undefined),
    buildKey: vi.fn(() => 'anon-key'),
  },
}));
vi.mock('../connectors/federatedProfileSync', () => ({
  federatedProfileSync: { syncOnProfileView: vi.fn(async () => false) },
}));

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { userSettings } from '../db/schema/userProfile';
import { ensureUserSettings, updateUserSettings } from '../db/userProfile/userSettingsRepository';
import { mtnFeedController } from '../mtn/controllers/feed.controller';

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (c: number) => MockRes;
  json: (b: unknown) => MockRes;
}
function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

/** One post-per-slice `SlicedFeedResponse`-shaped payload — only the fields the tuner and `syncFlattenedItemsWithSlices` read. */
function sensitiveAndCleanResponse(): unknown {
  return {
    slices: [
      {
        _sliceKey: 'sensitive-1',
        items: [{
          post: { id: 'sensitive-1', user: { id: 'author1' }, metadata: { isSensitive: true } },
          isThreadParent: false,
          isThreadChild: false,
          isThreadLastChild: false,
        }],
        isIncompleteThread: false,
      },
      {
        _sliceKey: 'clean-1',
        items: [{
          post: { id: 'clean-1', user: { id: 'author1' }, metadata: { isSensitive: false } },
          isThreadParent: false,
          isThreadChild: false,
          isThreadLastChild: false,
        }],
        isIncompleteThread: false,
      },
    ],
    items: [],
    hasMore: false,
    nextCursor: undefined,
    totalCount: 2,
  };
}

const PREFIX = 'feed-sensitive-tuner';
const created: string[] = [];

/** A viewer id unique to this file: suites share one database and run in parallel. */
function viewer(name: string): string {
  const id = `${PREFIX}-${name}`;
  created.push(id);
  return id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  vi.clearAllMocks();
  while (created.length > 0) {
    const id = created.pop();
    if (id) await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, id));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('MtnFeedController.getFeed → sensitive content tuner (viewer preference)', () => {
  it('hides a sensitive post for a viewer who explicitly opted OUT (showSensitiveContent: false)', async () => {
    const id = viewer('opted-out');
    await ensureUserSettings(id);
    await updateUserSettings(id, { set: { 'privacy.showSensitiveContent': false } });
    engineRun.mockResolvedValueOnce(sensitiveAndCleanResponse());

    const req = { query: { descriptor: 'for_you' }, user: { id } } as never;
    const res = makeRes();
    await mtnFeedController.getFeed(req, res as never);

    const body = res.body as { data: { items: Array<{ id: string }> } };
    expect(body.data.items.map((item) => item.id)).toEqual(['clean-1']);
  });

  it('shows a sensitive post for a viewer who explicitly opted IN (showSensitiveContent: true)', async () => {
    const id = viewer('opted-in');
    await ensureUserSettings(id);
    await updateUserSettings(id, { set: { 'privacy.showSensitiveContent': true } });
    engineRun.mockResolvedValueOnce(sensitiveAndCleanResponse());

    const req = { query: { descriptor: 'for_you' }, user: { id } } as never;
    const res = makeRes();
    await mtnFeedController.getFeed(req, res as never);

    const body = res.body as { data: { items: Array<{ id: string }> } };
    expect(body.data.items.map((item) => item.id).sort()).toEqual(['clean-1', 'sensitive-1']);
  });

  it('fails CLOSED (hides sensitive content) for a viewer who never set the preference — no settings row at all', async () => {
    const id = viewer('never-onboarded');
    // Deliberately no `ensureUserSettings` / `updateUserSettings` call: this
    // viewer has no row, matching an account that has never opened settings.
    engineRun.mockResolvedValueOnce(sensitiveAndCleanResponse());

    const req = { query: { descriptor: 'for_you' }, user: { id } } as never;
    const res = makeRes();
    await mtnFeedController.getFeed(req, res as never);

    const body = res.body as { data: { items: Array<{ id: string }> } };
    expect(body.data.items.map((item) => item.id)).toEqual(['clean-1']);
  });

  it('fails CLOSED when the settings lookup errors', async () => {
    const id = viewer('load-error');
    await ensureUserSettings(id);
    await updateUserSettings(id, { set: { 'privacy.showSensitiveContent': true } });

    // Simulate the settings read failing mid-request (e.g. a transient DB error)
    // by closing the pool the controller's own `loadFeedPreferences` call will hit,
    // then reconnecting afterward so the rest of the suite is unaffected.
    await closePostgres();
    engineRun.mockResolvedValueOnce(sensitiveAndCleanResponse());

    const req = { query: { descriptor: 'for_you' }, user: { id } } as never;
    const res = makeRes();
    try {
      await mtnFeedController.getFeed(req, res as never);
    } finally {
      await connectPostgres();
    }

    const body = res.body as { data: { items: Array<{ id: string }> } };
    expect(body.data.items.map((item) => item.id)).toEqual(['clean-1']);
  });

  it('fails CLOSED for an anonymous request (no authenticated viewer at all)', async () => {
    engineRun.mockResolvedValueOnce(sensitiveAndCleanResponse());

    const req = { query: { descriptor: 'for_you' }, user: undefined } as never;
    const res = makeRes();
    await mtnFeedController.getFeed(req, res as never);

    const body = res.body as { data: { items: Array<{ id: string }> } };
    expect(body.data.items.map((item) => item.id)).toEqual(['clean-1']);
  });
});
