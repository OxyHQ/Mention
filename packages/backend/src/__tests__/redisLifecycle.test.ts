import type { RedisClientType } from 'redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface FakeRedisClient {
  isReady: boolean;
  isOpen: boolean;
  attempts: Array<Deferred<unknown>>;
  handlers: Map<string, Array<(...args: unknown[]) => void>>;
  on: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): void;
}

const redisMock = vi.hoisted(() => ({
  clients: [] as FakeRedisClient[],
  createClient: vi.fn(),
}));

vi.unmock('../utils/redis');
vi.mock('redis', () => ({
  createClient: redisMock.createClient,
}));

function makeClient(): FakeRedisClient {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const client: FakeRedisClient = {
    isReady: false,
    isOpen: false,
    attempts: [],
    handlers,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return client;
    }),
    connect: vi.fn(() => {
      const attempt = deferred<unknown>();
      client.attempts.push(attempt);
      client.isOpen = true;
      return attempt.promise;
    }),
    quit: vi.fn(async () => {
      client.isOpen = false;
      client.isReady = false;
    }),
    destroy: vi.fn(() => {
      client.isOpen = false;
      client.isReady = false;
    }),
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
  return client;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function resolveReady(client: FakeRedisClient, attemptIndex: number): void {
  client.isReady = true;
  client.isOpen = true;
  client.emit('ready');
  client.attempts[attemptIndex].resolve(client);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.resetModules();
  redisMock.clients.length = 0;
  redisMock.createClient.mockReset();
  redisMock.createClient.mockImplementation(() => {
    const client = makeClient();
    redisMock.clients.push(client);
    return client;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Redis singleton supervisor', () => {
  it('shares one client and one connection attempt across concurrent hot paths', async () => {
    const redis = await import('../utils/redis.js');
    const clients = Array.from({ length: 50 }, () => redis.getRedisClient());

    expect(new Set(clients).size).toBe(1);
    expect(redisMock.createClient).toHaveBeenCalledOnce();
    expect(redisMock.clients[0].connect).toHaveBeenCalledOnce();
    expect(redis.getRedisStats()).toMatchObject({
      connected: false,
      status: 'connecting',
      attemptInFlight: true,
      retryScheduled: false,
    });
  });

  it('keeps the same client and fails fast throughout the cooldown', async () => {
    const redis = await import('../utils/redis.js');
    const client = redis.getRedisClient() as unknown as FakeRedisClient;

    client.attempts[0].reject(new Error('connect failed'));
    await flushPromises();

    expect(redis.getRedisStats()).toMatchObject({
      status: 'cooldown',
      failureCount: 1,
      retryScheduled: true,
      nextRetryAt: Date.now() + 1_000,
    });
    for (let index = 0; index < 50; index += 1) {
      expect(redis.getRedisClient()).toBe(client);
    }
    expect(redisMock.createClient).toHaveBeenCalledOnce();
    expect(client.connect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(999);
    expect(client.connect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(redis.getRedisClient()).toBe(client);
  });

  it('recovers the stable client and cancels further retries when Redis returns', async () => {
    const redis = await import('../utils/redis.js');
    const client = redis.getRedisClient() as unknown as FakeRedisClient;

    client.attempts[0].reject(new Error('ECONNREFUSED'));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    resolveReady(client, 1);
    await flushPromises();

    expect(redis.getRedisStats()).toMatchObject({
      connected: true,
      status: 'ready',
      attemptInFlight: false,
      failureCount: 0,
      retryScheduled: false,
      nextRetryAt: null,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(redisMock.createClient).toHaveBeenCalledOnce();
  });

  it('supervises a dropped ready connection without reconnecting from callers', async () => {
    const redis = await import('../utils/redis.js');
    const client = redis.getRedisClient() as unknown as FakeRedisClient;
    resolveReady(client, 0);
    await flushPromises();

    client.isReady = false;
    client.isOpen = false;
    client.emit('end');
    expect(redis.getRedisStats()).toMatchObject({
      connected: false,
      status: 'cooldown',
      retryScheduled: true,
    });

    redis.getRedisClient();
    redis.getRedisClient();
    expect(client.connect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.connect).toHaveBeenCalledTimes(2);
  });

  it('opens the circuit after a command timeout and recovers before running commands again', async () => {
    const redis = await import('../utils/redis.js');
    const { withRedisFallback } = await import('../utils/redisHelpers.js');
    const client = redis.getRedisClient() as unknown as FakeRedisClient;
    resolveReady(client, 0);
    await flushPromises();

    const timeout = Object.assign(new Error('command timed out'), {
      name: 'CommandTimeoutError',
    });
    const firstOperation = vi.fn(async () => {
      throw timeout;
    });
    await expect(
      withRedisFallback(
        client as unknown as RedisClientType,
        firstOperation,
        'fallback',
        'testCommand',
      ),
    ).resolves.toBe('fallback');

    expect(firstOperation).toHaveBeenCalledOnce();
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(redis.getRedisStats()).toMatchObject({
      connected: false,
      status: 'cooldown',
      failureCount: 1,
      retryScheduled: true,
    });

    const blockedOperation = vi.fn().mockResolvedValue('must-not-run');
    await expect(
      withRedisFallback(
        client as unknown as RedisClientType,
        blockedOperation,
        'fallback',
      ),
    ).resolves.toBe('fallback');
    expect(blockedOperation).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    resolveReady(client, 1);
    await flushPromises();

    const recoveredOperation = vi.fn().mockResolvedValue('recovered');
    await expect(
      withRedisFallback(
        client as unknown as RedisClientType,
        recoveredOperation,
        'fallback',
      ),
    ).resolves.toBe('recovered');
    expect(recoveredOperation).toHaveBeenCalledOnce();
    expect(redis.getRedisStats().status).toBe('ready');
  });

  it('makes shutdown terminal and ignores a late connection completion', async () => {
    const redis = await import('../utils/redis.js');
    const client = redis.getRedisClient() as unknown as FakeRedisClient;

    await redis.closeRedisConnection();
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(client.quit).not.toHaveBeenCalled();
    expect(redis.getRedisStats()).toMatchObject({
      connected: false,
      status: 'stopped',
      attemptInFlight: false,
      retryScheduled: false,
      nextRetryAt: null,
    });

    resolveReady(client, 0);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(redis.getRedisClient()).toBe(client);
    expect(redisMock.createClient).toHaveBeenCalledOnce();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(redis.getRedisStats().status).toBe('stopped');
  });

  it('cancels a scheduled retry and gracefully quits a ready client', async () => {
    const redis = await import('../utils/redis.js');
    const client = redis.getRedisClient() as unknown as FakeRedisClient;
    resolveReady(client, 0);
    await flushPromises();

    await redis.closeRedisConnection();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.destroy).not.toHaveBeenCalled();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(redis.getRedisStats().status).toBe('stopped');
  });
});
