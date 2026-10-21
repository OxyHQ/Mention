import { beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => {
  const entries = new Map<string, string>();
  const history = new Map<string, string[]>();
  return {
    history,
    isReady: true,
    entries,
    get: vi.fn(async (key: string) => entries.get(key) ?? null),
    eval: vi.fn(async (_script: string, options: { keys: string[]; arguments: string[] }) => {
      const [key, historyKey] = options.keys;
      entries.set(key, options.arguments[0]);
      const keys = [key, ...(history.get(historyKey) ?? [])];
      for (const expired of keys.slice(3)) entries.delete(expired);
      history.set(historyKey, keys.slice(0, 3));
      return 1;
    }),
  };
});
vi.mock('../utils/redis', () => ({
  getRedisClient: () => redis,
  reportRedisConnectionFailure: vi.fn(),
}));

import {
  RankedFeedSessionStore,
  rankedSessionBinding,
  RANKED_SESSION_TTL_MS,
  type RankedFeedSession,
} from '../mtn/feed/RankedFeedSession';
import type { FeedDefinition } from '../mtn/feed/engine/types';

const store = new RankedFeedSessionStore();
const definition: FeedDefinition = {
  id: 'media',
  title: 'Media',
  mode: 'ranked',
  sources: [],
  filters: [],
  signals: [],
};
function state(): RankedFeedSession {
  return {
    binding: rankedSessionBinding(definition, { currentUserId: 'viewer' }, 20),
    asOf: Date.now(),
    expiresAt: Date.now() + RANKED_SESSION_TTL_MS,
    pending: [{ id: 'post', score: 3, discovery: true }],
    scannedIds: ['post'],
    initialSeenIds: [],
    deliveredIds: [],
    sourceCursors: { media: 'source-boundary' },
    exhaustedSources: [],
    phase: 'ranked',
  };
}
beforeEach(() => {
  redis.isReady = true;
  redis.entries.clear();
  redis.history.clear();
  vi.clearAllMocks();
});

describe('ranked feed session storage', () => {
  it('treats graph arrays as sets when binding a continuation', () => {
    expect(
      rankedSessionBinding(
        definition,
        { currentUserId: 'viewer', followingIds: ['b', 'a', 'a'], mutedLaneIds: ['z', 'y'] },
        20,
      ),
    ).toBe(
      rankedSessionBinding(
        definition,
        { currentUserId: 'viewer', followingIds: ['a', 'b'], mutedLaneIds: ['y', 'z'] },
        20,
      ),
    );
  });

  it('rejects a continuation after the viewer disables a bell, while ignoring graph order', async () => {
    const initial = state();
    const ctx = { currentUserId: 'viewer', activitySubscribedAuthorIds: ['b', 'a'] };
    initial.binding = rankedSessionBinding(definition, ctx, 20);
    const cursor = await store.save(initial);
    expect(
      await store.load(
        cursor,
        rankedSessionBinding(definition, { ...ctx, activitySubscribedAuthorIds: ['a', 'b'] }, 20),
      ),
    ).toEqual(initial);
    await expect(
      store.load(
        cursor,
        rankedSessionBinding(definition, { ...ctx, activitySubscribedAuthorIds: ['a'] }, 20),
      ),
    ).rejects.toMatchObject({ statusCode: 410, code: 'FEED_CURSOR_EXPIRED' });
  });

  it('stores immutable minimal state with a thirty-minute lifetime', async () => {
    const initial = state();
    const cursor = await store.save(initial);
    const loaded = await store.load(cursor, initial.binding);
    expect(loaded).toEqual(initial);
    loaded.pending = [];
    expect((await store.load(cursor, initial.binding)).pending).toHaveLength(1);
    expect(redis.eval.mock.calls[0]?.[1].arguments[1]).toBe('1800');
    expect(cursor).toMatch(/^fs1:[0-9a-f-]{36}$/);
  });

  it('bounds retained deep-scroll snapshots and explicitly expires older cursors', async () => {
    const initial = state();
    const cursors: string[] = [];
    for (let page = 0; page < 20; page += 1) cursors.push(await store.save(initial));
    expect(redis.entries.size).toBe(3);
    await expect(store.load(cursors[0], initial.binding)).rejects.toMatchObject({
      code: 'FEED_CURSOR_EXPIRED',
    });
    expect(await store.load(cursors[19], initial.binding)).toEqual(initial);
  });

  it('fails closed on another viewer, another filter, missing state and expiration', async () => {
    const initial = state();
    const cursor = await store.save(initial);
    const code = { statusCode: 410, code: 'FEED_CURSOR_EXPIRED' };
    await expect(
      store.load(cursor, rankedSessionBinding(definition, { currentUserId: 'other' }, 20)),
    ).rejects.toMatchObject(code);
    await expect(
      store.load(
        cursor,
        rankedSessionBinding(
          definition,
          { currentUserId: 'viewer', videoFilters: { orientation: 'portrait' } },
          20,
        ),
      ),
    ).rejects.toMatchObject(code);
    redis.entries.set(
      `feed:session:${cursor}`,
      JSON.stringify({ ...initial, expiresAt: Date.now() - 1 }),
    );
    await expect(store.load(cursor, initial.binding)).rejects.toMatchObject(code);
    redis.entries.clear();
    await expect(store.load(cursor, initial.binding)).rejects.toMatchObject(code);
    await expect(store.load('fs1:invalid', initial.binding)).rejects.toMatchObject(code);
  });

  it('requires a restart when Redis cannot continue an existing session', async () => {
    redis.isReady = false;
    expect(store.available()).toBe(false);
    await expect(store.save(state())).rejects.toMatchObject({
      statusCode: 410,
      code: 'FEED_CURSOR_EXPIRED',
    });
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
