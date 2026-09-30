import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { CachedUserSummary } from '../../services/userSummaryCache';

const { getMany, getUser, blocked, restricted, following, followers, cache } = vi.hoisted(() => ({
  getMany: vi.fn(),
  getUser: vi.fn(),
  blocked: vi.fn(),
  restricted: vi.fn(),
  following: vi.fn(),
  followers: vi.fn(),
  cache: new Map<string, CachedUserSummary>(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ users: { getMany, get: getUser } }),
}));
vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ users: { get: getUser } }),
}));
vi.mock('../../utils/privacyHelpers', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../utils/privacyHelpers')>(),
  getBlockedUserIds: blocked,
  getRestrictedUserIds: restricted,
  getFollowingIds: following,
  getFollowerIds: followers,
}));
vi.mock('../../services/userSummaryCache', () => ({
  mget: async (ids: string[]) => new Map(ids.flatMap((id) => {
    const value = cache.get(id);
    return value ? [[id, value] as const] : [];
  })),
  mset: async (entries: Map<string, CachedUserSummary>) => {
    for (const [id, value] of entries) cache.set(id, value);
  },
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { PostHydrationService } from '../../services/PostHydrationService';
import type { HydrationOptions } from '../../services/PostHydrationService';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

const scope = postScope('hydration-latency');
const service = new PostHydrationService();
// Only the remote boundary is delayed. Post assembly, ACLs and all SQL are real.
const REMOTE_LATENCY_MS = 40;

beforeAll(connectPostgres);
afterAll(closePostgres);
afterEach(async () => { await clearPostScope(scope); });
beforeEach(() => {
  cache.clear();
  for (const read of [getMany, getUser, blocked, restricted, following, followers]) read.mockReset();
  getMany.mockImplementation(async (ids: string[]) => {
    await delay(REMOTE_LATENCY_MS);
    return ids.map((id) => ({ id, username: id, name: { displayName: id } }));
  });
  getUser.mockRejectedValue(new Error('unresolved identity'));
  for (const read of [blocked, restricted, following, followers]) {
    read.mockImplementation(async () => { await delay(REMOTE_LATENCY_MS); return []; });
  }
});

describe('feed hydration latency', () => {
  it.each([
    ['anonymous', {}],
    ['authenticated', { viewerId: scope.user('viewer') }],
    ['preloaded feed context', {
      viewerId: scope.user('viewer'), viewerLanguages: [],
      viewerPrivacy: { blockedIds: [], restrictedIds: [] },
      viewerGraph: { followingIds: [], followerIds: [] },
    }],
  ] satisfies Array<[string, HydrationOptions]>)('%s batches authors and mentions on cold and warm pages', async (scenario, options) => {
    const posts = [];
    for (let index = 0; index < 20; index += 1) {
      posts.push(await seedPost(scope, {
        oxyUserId: scope.user(`author-${index}`),
        mentions: [scope.user(`mention-${index}`)],
        content: { variants: [{ tag: 'en', source: 'author', text: `Hello [mention:${scope.user(`mention-${index}`)}]` }] },
      }));
    }
    const started = performance.now();
    const result = await service.hydratePosts(posts, options);
    const elapsedMs = performance.now() - started;
    const coldCalls = getMany.mock.calls.length;
    expect(result).toHaveLength(20);
    expect(result[0].content.text).toContain(`[@${scope.user('mention-0')}]`);
    getMany.mockClear();
    const warmStarted = performance.now();
    const warm = await service.hydratePosts(posts, options);
    console.info(JSON.stringify({ scenario, elapsedMs: Math.round(elapsedMs), warmMs: Math.round(performance.now() - warmStarted), coldCalls }));
    expect(warm).toEqual(result);
    expect(getMany).not.toHaveBeenCalled();
    expect(coldCalls).toBe(scenario === 'authenticated' ? 2 : 1);
  });

  it('starts independent viewer reads together and waits for privacy before returning posts', async () => {
    const post = await seedPost(scope);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    getMany.mockImplementation(async (ids: string[]) => {
      await gate;
      return ids.map((id) => ({ id, username: id }));
    });
    blocked.mockImplementation(async () => { await gate; return [post.oxyUserId]; });
    let settled = false;
    const result = service.hydratePosts([post], { viewerId: scope.user('viewer') });
    void result.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => {
        expect(getMany).toHaveBeenCalled();
        expect(blocked).toHaveBeenCalled();
        expect(restricted).toHaveBeenCalled();
        expect(following).toHaveBeenCalled();
        expect(followers).toHaveBeenCalled();
      }, { timeout: 500 });
      expect(settled).toBe(false);
    } finally {
      release();
      await result;
    }
    expect(await result).toEqual([]);
  });

  it('keeps privacy failures fail-closed when concurrent reads succeed', async () => {
    const post = await seedPost(scope);
    blocked.mockRejectedValue(new Error('privacy unavailable'));
    await expect(service.hydratePosts([post], {
      viewerId: scope.user('viewer'), viewerLanguages: [],
      viewerGraph: { followingIds: [], followerIds: [] },
    }))
      .rejects.toThrow('privacy unavailable');
  });

  it('does not retry an unresolved mention for every post or cache it across requests', async () => {
    const missing = scope.user('missing');
    getMany.mockImplementation(async (ids: string[]) => {
      await delay(REMOTE_LATENCY_MS);
      return ids.filter((id) => id !== missing).map((id) => ({ id, username: id }));
    });
    const posts = [];
    for (let index = 0; index < 5; index += 1) {
      posts.push(await seedPost(scope, {
        mentions: [missing],
        content: { variants: [{ tag: 'en', source: 'author', text: `Hello [mention:${missing}]` }] },
      }));
    }
    const result = await service.hydratePosts(posts);
    expect(result).toHaveLength(5);
    expect(result.every((post) => post.content.text === `Hello [mention:${missing}]`)).toBe(true);
    expect(cache.has(missing)).toBe(false);
    expect(getMany).toHaveBeenCalledTimes(1);
    expect(getUser).toHaveBeenCalledTimes(1);
    getMany.mockClear();
    await service.hydratePosts(posts);
    expect(getMany).toHaveBeenCalledWith([missing]);
  });
});
