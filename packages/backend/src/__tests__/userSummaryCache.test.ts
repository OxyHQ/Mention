/**
 * Regression tests for the author-summary cache's MGET guard.
 *
 * A Redis client/server can hand back a NON-array reply for `MGET` (observed
 * against ElastiCache Valkey). Before the guard, `values.forEach(...)` threw a
 * `TypeError` that `withRedisFallback` re-throws (it only degrades CONNECTION
 * errors), 500-ing every ranked feed. These tests lock in that a non-array reply
 * degrades to a full cache miss WITHOUT throwing, that the happy array path still
 * parses hits, and that the root-cause diagnostic escalates to `warn` at most
 * once per process (bounded, never per-request).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mGet: vi.fn(),
  multi: vi.fn(),
  setEx: vi.fn(),
  exec: vi.fn(),
  del: vi.fn(),
  ping: vi.fn(),
  connect: vi.fn(),
}));

// A ready client makes `withRedisFallback` run MGET directly. Readiness checks
// must never add a PING/connect round-trip on this hot hydration path.
vi.mock('../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    isReady: true,
    isOpen: true,
    connect: mocks.connect,
    ping: mocks.ping,
    mGet: mocks.mGet,
    multi: mocks.multi,
    del: mocks.del,
  }),
}));

import { invalidate, mget, mset } from '../services/userSummaryCache';
import { logger } from '../utils/logger';

const summaryFor = (id: string) => ({
  summary: {
    id,
    username: `user_${id}`,
    name: { displayName: `User ${id}` },
    avatar: null,
  },
  followerCount: 7,
});

describe('userSummaryCache.mget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.multi.mockReturnValue({
      setEx: mocks.setEx,
      exec: mocks.exec,
    });
    mocks.exec.mockResolvedValue([]);
    mocks.del.mockResolvedValue(1);
  });

  // NOTE: `nonArrayReplyWarned` is a module-level latch, so this test — the first
  // one to send a non-array reply — is the one that can observe the single `warn`.
  it('treats a non-array MGET reply as a full cache miss without throwing, warning once', async () => {
    mocks.mGet.mockResolvedValue({ not: 'an-array' });

    // Two calls: the guard must degrade both to an empty map, and the `warn`
    // diagnostic must fire EXACTLY once (the `debug` line fires on each).
    const first = await mget(['a', 'b']);
    const second = await mget(['c']);

    expect(first.size).toBe(0);
    expect(second.size).toBe(0);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('non-array'),
      expect.objectContaining({
        replyType: 'object',
        constructorName: 'Object',
        sample: expect.stringContaining('not'),
        keyCount: 2,
      }),
    );
    // Per-request debug line for every non-array occurrence (never escalated).
    expect(logger.debug).toHaveBeenCalledTimes(2);
  });

  it('treats a null MGET reply as a cache miss without throwing', async () => {
    mocks.mGet.mockResolvedValue(null);

    await expect(mget(['x'])).resolves.toEqual(new Map());
  });

  it('parses cached hits from a normal array reply and skips misses', async () => {
    const cached = summaryFor('u1');
    mocks.mGet.mockResolvedValue([JSON.stringify(cached), null]);

    const result = await mget(['u1', 'u2']);

    expect(result.get('u1')).toEqual(cached);
    expect(result.has('u2')).toBe(false);
    expect(result.size).toBe(1);
    expect(mocks.ping).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('skips corrupt (unparseable) entries instead of throwing', async () => {
    const cached = summaryFor('u1');
    mocks.mGet.mockResolvedValue([JSON.stringify(cached), '{not valid json']);

    const result = await mget(['u1', 'u2']);

    expect(result.get('u1')).toEqual(cached);
    expect(result.has('u2')).toBe(false);
  });

  it('short-circuits to an empty map for an empty id list without touching Redis', async () => {
    const result = await mget([]);

    expect(result.size).toBe(0);
    expect(mocks.mGet).not.toHaveBeenCalled();
  });

  it('writes through one pipeline without a readiness PING', async () => {
    await mset(new Map([[
      'u1',
      {
        user: summaryFor('u1').summary,
        followerCount: 7,
      },
    ]]));

    expect(mocks.multi).toHaveBeenCalledTimes(1);
    expect(mocks.setEx).toHaveBeenCalledTimes(1);
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.ping).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('invalidates directly without a readiness PING', async () => {
    await invalidate(['u1', 'u2']);

    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.ping).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
