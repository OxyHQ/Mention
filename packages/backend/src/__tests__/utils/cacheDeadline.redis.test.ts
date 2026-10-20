import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// This gate deliberately uses the real supervisor and node-redis transport.
// Its URL must select a dedicated disposable Redis: CLIENT PAUSE affects the
// whole instance, so never share TEST_REDIS_URL with other concurrent gates.
vi.unmock('../../utils/redis');
vi.mock('../../config', () => ({
  getRedisConnectionConfig: () => ({ url: process.env.TEST_REDIS_DEADLINE_URL }),
}));

import { createCache } from '../../utils/cache';
import { closeRedisConnection, getRedisClient, getRedisStats } from '../../utils/redis';

const redisUrl = process.env.TEST_REDIS_DEADLINE_URL ?? '';
const suite = redisUrl ? describe : describe.skip;

suite('cache response deadlines on a real Redis', () => {
  const prefix = `test:cache-deadline:${process.pid}:${Date.now()}`;
  let observer: ReturnType<typeof createClient>;

  beforeAll(async () => {
    observer = createClient({ url: redisUrl });
    await observer.connect();
    getRedisClient();
    await vi.waitFor(() => expect(getRedisStats().connected).toBe(true));
  });

  afterAll(async () => {
    await closeRedisConnection();
    const keys = await observer.keys(`${prefix}:*`);
    if (keys.length) await observer.del(keys);
    await observer.quit();
  });

  it.each(['read', 'pipeline'] as const)(
    'bounds a stalled-ready %s, destroys its socket and recovers without restarting',
    async (operation) => {
      const cache = createCache({ name: 'DeadlineIntegration', ttlSeconds: 30 });
      const client = getRedisClient();
      await observer.clientPause(1_800, 'ALL');
      expect(client.isReady).toBe(true);
      const started = performance.now();
      if (operation === 'read') {
        await expect(cache.get(`${prefix}:missing`)).resolves.toBeUndefined();
      } else {
        await cache.setMany(
          Array.from({ length: 201 }, (_, index) => [`${prefix}:batch:${index}`, index] as const),
        );
      }
      expect(performance.now() - started).toBeLessThan(1_600);
      expect(getRedisStats()).toMatchObject({ connected: false, status: 'cooldown' });
      expect(client.isOpen).toBe(false);
      await expect.poll(() => getRedisStats().connected, { timeout: 5_000 }).toBe(true);
      expect(getRedisClient()).toBe(client);
      // At most the first pipeline was sent before the timeout. A later batch
      // must never be sent after reconnect, even if old replies arrive late.
      expect(await observer.exists(`${prefix}:batch:200`)).toBe(0);
      await cache.set(`${prefix}:healthy`, { ready: true });
      await expect(cache.get(`${prefix}:healthy`)).resolves.toEqual({ ready: true });
    },
    10_000,
  );
});
