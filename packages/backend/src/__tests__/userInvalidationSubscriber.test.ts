/**
 * Tests for the Oxy user-invalidation subscriber.
 *
 * The three properties that make this safe to run on every task:
 *
 *  - A `profile` invalidation drops ALL THREE caches — the shared Redis
 *    user-summary entry plus BOTH per-process Oxy client response caches. The
 *    SDK caches are per-process, so missing them leaves each task serving its
 *    own stale `GET /users/:id` for another five minutes; the Redis eviction
 *    alone is not sufficient and a test that only asserted it would pass while
 *    the bug survived.
 *  - Startup is INERT on failure. No Redis, a refused connection or a failed
 *    subscribe must return `null` and never throw into server boot — losing the
 *    push signal costs a TTL, while throwing costs the process.
 *  - The subscribe confirmation is logged, because it is the only evidence the
 *    signal is live: a subscriber that silently failed to attach looks exactly
 *    like one attached to a quiet channel.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OXY_USER_INVALIDATION_CHANNEL } from '@oxyhq/contracts';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  quit: vi.fn(),
  publisherQuit: vi.fn(),
  invalidateUserSummaries: vi.fn(),
  serviceClearEntry: vi.fn(),
  serviceClearPrefix: vi.fn(),
  runtimeClearEntry: vi.fn(),
  runtimeClearPrefix: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../utils/redis', () => ({
  createRedisPubSub: () => ({
    subscriber: {
      isOpen: true,
      connect: mocks.connect,
      subscribe: mocks.subscribe,
      unsubscribe: mocks.unsubscribe,
      quit: mocks.quit,
    },
    publisher: { isOpen: true, quit: mocks.publisherQuit },
  }),
}));

vi.mock('../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    clearCacheEntry: mocks.serviceClearEntry,
    clearCacheByPrefix: mocks.serviceClearPrefix,
  }),
}));

vi.mock('../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    clearCacheEntry: mocks.runtimeClearEntry,
    clearCacheByPrefix: mocks.runtimeClearPrefix,
  }),
}));

vi.mock('../services/userSummaryCache', () => ({
  invalidate: mocks.invalidateUserSummaries,
}));

vi.mock('../utils/logger', () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));

import { startUserInvalidationSubscriber } from '../services/userInvalidationSubscriber';

/** Run the handler the subscriber registered, as Redis would on a message. */
function deliver(raw: string): void {
  const handler = mocks.subscribe.mock.calls[0]?.[1] as (message: string) => void;
  handler(raw);
}

const VALID = JSON.stringify({ userId: 'user-1', reason: 'profile', at: 1 });

describe('startUserInvalidationSubscriber', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.subscribe.mockResolvedValue(undefined);
    mocks.unsubscribe.mockResolvedValue(undefined);
    mocks.quit.mockResolvedValue(undefined);
    mocks.publisherQuit.mockResolvedValue(undefined);
  });

  it('subscribes to the contract channel and logs the confirmation', async () => {
    const handle = await startUserInvalidationSubscriber();

    expect(handle).not.toBeNull();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe.mock.calls[0][0]).toBe(OXY_USER_INVALIDATION_CHANNEL);
    expect(mocks.info).toHaveBeenCalledWith(
      '[UserInvalidation] subscriber enabled',
      { channel: OXY_USER_INVALIDATION_CHANNEL },
    );
  });

  it('drops the Redis summary AND both per-process SDK caches', async () => {
    await startUserInvalidationSubscriber();
    deliver(VALID);

    expect(mocks.invalidateUserSummaries).toHaveBeenCalledWith(['user-1']);
    // Both clients, or one task keeps answering from its own stale copy.
    expect(mocks.serviceClearEntry).toHaveBeenCalledWith('GET:/users/user-1');
    expect(mocks.runtimeClearEntry).toHaveBeenCalledWith('GET:/users/user-1');
    expect(mocks.serviceClearPrefix).toHaveBeenCalled();
    expect(mocks.runtimeClearPrefix).toHaveBeenCalled();
  });

  it('ignores a message that fails the contract schema', async () => {
    await startUserInvalidationSubscriber();
    // `graph` is suppressed at the publisher and rejected by the wire schema.
    deliver(JSON.stringify({ userId: 'user-1', reason: 'graph', at: 1 }));
    deliver('not json');

    expect(mocks.invalidateUserSummaries).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalled();
  });

  it('never throws out of the message handler', async () => {
    mocks.invalidateUserSummaries.mockImplementation(() => {
      throw new Error('redis down');
    });
    await startUserInvalidationSubscriber();

    expect(() => deliver(VALID)).not.toThrow();
  });

  it('returns null instead of throwing when the connection fails', async () => {
    mocks.connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(startUserInvalidationSubscriber()).resolves.toBeNull();
    expect(mocks.warn).toHaveBeenCalled();
  });

  it('returns null instead of throwing when subscribing fails', async () => {
    mocks.subscribe.mockRejectedValue(new Error('subscribe failed'));

    await expect(startUserInvalidationSubscriber()).resolves.toBeNull();
  });

  it('unsubscribes and closes both clients on stop', async () => {
    const handle = await startUserInvalidationSubscriber();
    await handle?.stop();

    expect(mocks.unsubscribe).toHaveBeenCalledWith(OXY_USER_INVALIDATION_CHANNEL);
    expect(mocks.quit).toHaveBeenCalled();
    expect(mocks.publisherQuit).toHaveBeenCalled();
  });
});
