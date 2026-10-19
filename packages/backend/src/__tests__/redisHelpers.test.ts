import type { RedisClientType } from '../utils/redis';
import { describe, expect, it, jest, mock } from 'bun:test';
import {
  isRedisConnectionError,
  REDIS_RESPONSE_DEADLINE_MS,
  withRedisFallback,
} from '../utils/redisHelpers';

function redisClient(overrides: Record<string, unknown>): RedisClientType {
  return {
    isReady: false,
    isOpen: false,
    ping: mock(),
    connect: mock(),
    ...overrides,
  } as unknown as RedisClientType;
}

describe('redis hot-path fallback', () => {
  it('runs a ready operation without PINGing or reconnecting', async () => {
    const ping = mock();
    const connect = mock();
    const operation = mock().mockResolvedValue('result');
    const client = redisClient({ isReady: true, isOpen: true, ping, connect });

    await expect(withRedisFallback(client, operation, 'fallback')).resolves.toBe('result');
    expect(operation).toHaveBeenCalledOnce();
    expect(ping).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('falls back immediately when the shared client is not ready', async () => {
    const operation = mock();
    const connect = mock();
    const client = redisClient({ isOpen: true, connect });

    await expect(withRedisFallback(client, operation, 'fallback')).resolves.toBe('fallback');
    expect(operation).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('degrades when readiness races with a closed socket', async () => {
    const closed = Object.assign(new Error('The client is closed'), {
      name: 'ClientClosedError',
    });
    const client = redisClient({ isReady: true, isOpen: true });

    await expect(
      withRedisFallback(
        client,
        async () => {
          throw closed;
        },
        0,
      ),
    ).resolves.toBe(0);
  });

  it('falls back when a ready socket stops answering', async () => {
    jest.useFakeTimers();
    try {
      const client = redisClient({ isReady: true, isOpen: true });
      const pending = withRedisFallback(client, () => new Promise<string>(() => {}), 'fallback');
      jest.advanceTimersByTime(REDIS_RESPONSE_DEADLINE_MS);
      await expect(pending).resolves.toBe('fallback');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not hide non-connection command failures', async () => {
    const failure = new Error('WRONGTYPE Operation against a key');
    const client = redisClient({ isReady: true, isOpen: true });

    await expect(
      withRedisFallback(
        client,
        async () => {
          throw failure;
        },
        0,
      ),
    ).rejects.toBe(failure);
  });

  it('recognizes common transient Redis socket failures', () => {
    expect(isRedisConnectionError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(
      true,
    );
    expect(isRedisConnectionError(new Error('Socket closed unexpectedly'))).toBe(true);
    expect(
      isRedisConnectionError(
        Object.assign(new Error('timed out'), {
          name: 'SocketTimeoutError',
        }),
      ),
    ).toBe(true);
    expect(isRedisConnectionError(new Error('WRONGTYPE'))).toBe(false);
  });
});
