import type { RedisClientType } from 'redis';
import { describe, expect, it, vi } from 'vitest';
import {
  ensureRedisConnected,
  isRedisConnectionError,
  withRedisFallback,
} from '../utils/redisHelpers';

function redisClient(overrides: Record<string, unknown>): RedisClientType {
  return {
    isReady: false,
    isOpen: false,
    ping: vi.fn(),
    connect: vi.fn(),
    ...overrides,
  } as unknown as RedisClientType;
}

describe('redis hot-path fallback', () => {
  it('uses the ready-state signal without PINGing or reconnecting', async () => {
    const ping = vi.fn();
    const connect = vi.fn();
    const client = redisClient({ isReady: true, isOpen: true, ping, connect });

    await expect(ensureRedisConnected(client)).resolves.toBe(true);
    expect(ping).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('falls back immediately when the shared client is not ready', async () => {
    const operation = vi.fn();
    const connect = vi.fn();
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
      withRedisFallback(client, async () => {
        throw closed;
      }, 0),
    ).resolves.toBe(0);
  });

  it('does not hide non-connection command failures', async () => {
    const failure = new Error('WRONGTYPE Operation against a key');
    const client = redisClient({ isReady: true, isOpen: true });

    await expect(
      withRedisFallback(client, async () => {
        throw failure;
      }, 0),
    ).rejects.toBe(failure);
  });

  it('recognizes common transient Redis socket failures', () => {
    expect(isRedisConnectionError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRedisConnectionError(new Error('Socket closed unexpectedly'))).toBe(true);
    expect(isRedisConnectionError(Object.assign(new Error('timed out'), {
      name: 'SocketTimeoutError',
    }))).toBe(true);
    expect(isRedisConnectionError(new Error('WRONGTYPE'))).toBe(false);
  });
});
