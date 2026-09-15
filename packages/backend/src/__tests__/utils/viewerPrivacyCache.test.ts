/**
 * The viewer privacy cache (`resolveViewerPrivacyLists`).
 *
 * What these pin is the reason it exists: the blocked/restricted read fails
 * CLOSED, so before this cache a single Oxy 429 became an error on the reader's
 * screen for every request they made. The cache must therefore
 *
 *  - ask Oxy at most once per viewer per freshness window,
 *  - keep answering from the last lists Oxy confirmed when a refresh fails,
 *  - still fail closed for a viewer it has never resolved, and
 *  - hand every caller its own arrays, because callers push ids onto them.
 *
 * The real {@link createCache} runs against an in-memory Redis double, so the
 * stale-while-revalidate behaviour under test is the primitive's own, not a
 * re-implementation of it inside the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

const client = {
  isReady: true,
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  mGet: vi.fn(async (keys: string[]) => keys.map((key) => store.get(key) ?? null)),
  exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
  setEx: vi.fn(async (key: string, _ttl: number, value: string) => {
    store.set(key, value);
    return 'OK';
  }),
  del: vi.fn(async (keys: string[] | string) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    return 1;
  }),
  multi: vi.fn(),
};

vi.mock('../../utils/redis', () => ({
  getRedisClient: () => client,
  reportRedisConnectionFailure: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({}),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({}),
}));

import {
  getBlockedUserIds,
  getRestrictedUserIds,
  invalidateViewerPrivacyLists,
  type OxyClient,
} from '../../utils/privacyHelpers';


/**
 * The pair as every request path reads it: both lists for one viewer, keyed by
 * that viewer so the cache applies.
 */
async function resolveViewerPrivacyLists(
  viewerId: string,
  client: OxyClient,
): Promise<{ blockedIds: string[]; restrictedIds: string[] }> {
  const [blockedIds, restrictedIds] = await Promise.all([
    getBlockedUserIds(client, viewerId),
    getRestrictedUserIds(client, viewerId),
  ]);
  return { blockedIds, restrictedIds };
}

const VIEWER = 'viewer-1';

/** Freshness is 30s; this is comfortably past it without touching retention. */
const PAST_FRESHNESS_MS = 60 * 1000;

function oxyClientReturning(blocked: string[], restricted: string[]) {
  return {
    getBlockedUsers: vi.fn(async () => blocked.map((blockedId) => ({ blockedId }))),
    getRestrictedUsers: vi.fn(async () => restricted.map((restrictedId) => ({ restrictedId }))),
  } as unknown as OxyClient & {
    getBlockedUsers: ReturnType<typeof vi.fn>;
    getRestrictedUsers: ReturnType<typeof vi.fn>;
  };
}

/** Let a background stale refresh settle before asserting on it. */
async function settleBackgroundRefresh(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  client.isReady = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-15T22:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveViewerPrivacyLists', () => {
  it('reads Oxy once per viewer within the freshness window', async () => {
    const oxy = oxyClientReturning(['blocked-1'], ['restricted-1']);

    const first = await resolveViewerPrivacyLists(VIEWER, oxy);
    const second = await resolveViewerPrivacyLists(VIEWER, oxy);

    expect(first).toEqual({ blockedIds: ['blocked-1'], restrictedIds: ['restricted-1'] });
    expect(second).toEqual(first);
    expect(oxy.getBlockedUsers).toHaveBeenCalledTimes(1);
    expect(oxy.getRestrictedUsers).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the last confirmed lists when Oxy stops answering', async () => {
    const healthy = oxyClientReturning(['blocked-1'], []);
    await resolveViewerPrivacyLists(VIEWER, healthy);

    vi.setSystemTime(Date.now() + PAST_FRESHNESS_MS);
    const rateLimited = {
      getBlockedUsers: vi.fn(async () => {
        throw Object.assign(new Error('HTTP 429: Too Many Requests'), { status: 429 });
      }),
      getRestrictedUsers: vi.fn(async () => []),
    } as unknown as OxyClient;

    const served = await resolveViewerPrivacyLists(VIEWER, rateLimited);
    await settleBackgroundRefresh();

    expect(served).toEqual({ blockedIds: ['blocked-1'], restrictedIds: [] });
    // The failed refresh must not have replaced the retained entry.
    expect(await resolveViewerPrivacyLists(VIEWER, rateLimited)).toEqual({
      blockedIds: ['blocked-1'],
      restrictedIds: [],
    });
  });

  it('fails closed for a viewer it has never resolved', async () => {
    const rateLimited = {
      getBlockedUsers: vi.fn(async () => {
        throw Object.assign(new Error('HTTP 429: Too Many Requests'), { status: 429 });
      }),
      getRestrictedUsers: vi.fn(async () => []),
    } as unknown as OxyClient;

    await expect(resolveViewerPrivacyLists(VIEWER, rateLimited)).rejects.toThrow(
      'Oxy could not resolve the delegated blocked privacy context',
    );
    // Nothing was retained for the list that failed, so the next read fails
    // closed too rather than being answered from a half-resolved state.
    expect([...store.keys()]).not.toContain(`mtn:viewer:privacy:v1:blocked:${VIEWER}`);
  });

  it('hands each caller its own arrays', async () => {
    const oxy = oxyClientReturning(['blocked-1'], []);

    const first = await resolveViewerPrivacyLists(VIEWER, oxy);
    first.blockedIds.push('federated-1');

    expect((await resolveViewerPrivacyLists(VIEWER, oxy)).blockedIds).toEqual(['blocked-1']);
  });

  it('resolves from Oxy again after the viewer invalidates their entry', async () => {
    const oxy = oxyClientReturning(['blocked-1'], []);
    await resolveViewerPrivacyLists(VIEWER, oxy);

    await invalidateViewerPrivacyLists(VIEWER);
    const afterBlock = oxyClientReturning(['blocked-1', 'blocked-2'], []);
    const served = await resolveViewerPrivacyLists(VIEWER, afterBlock);

    expect(served.blockedIds).toEqual(['blocked-1', 'blocked-2']);
    expect(afterBlock.getBlockedUsers).toHaveBeenCalledTimes(1);
  });

  it('caches per viewer, never across viewers', async () => {
    const mine = oxyClientReturning(['blocked-1'], []);
    const theirs = oxyClientReturning(['blocked-2'], []);

    await resolveViewerPrivacyLists(VIEWER, mine);
    const other = await resolveViewerPrivacyLists('viewer-2', theirs);

    expect(other.blockedIds).toEqual(['blocked-2']);
    expect(theirs.getBlockedUsers).toHaveBeenCalledTimes(1);
  });
});
