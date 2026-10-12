import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setExInBatches } from '../../utils/redisHelpers';

/**
 * Batch cache writes against a REAL Redis, with the command client's own queue
 * cap (`commandsQueueMaxLength: 1000`, `utils/redis.ts`). Runs when
 * `TEST_REDIS_URL` is set; CI has no Redis, so it is skipped there.
 *
 * The negative control is the bug itself: a MULTI larger than the queue leaves
 * the connection inside a server-side transaction, after which every command
 * answers `QUEUED` and none runs. That is what one oversized cache write did to
 * a production task (2026-10-12). If node-redis ever fixes it, the control
 * fails and says so.
 */
const redisUrl = process.env.TEST_REDIS_URL ?? '';
const suite = redisUrl ? describe : describe.skip;

function productionShapedClient() {
  return createClient({
    url: redisUrl,
    RESP: 2,
    commandsQueueMaxLength: 1_000,
    disableOfflineQueue: true,
    commandOptions: { timeout: undefined },
  } as Parameters<typeof createClient>[0]);
}

/** Retry a command while the client still reports a full queue, for up to 5 s. */
async function answerOnceDrained<T>(command: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return await command();
    } catch (error) {
      const full = error instanceof Error && error.message === 'The queue is full';
      if (!full || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

suite('batch writes on a real Redis', () => {
  const prefix = `test:redis-batch:${process.pid}:${Date.now()}`;
  let observer: ReturnType<typeof createClient>;

  beforeAll(async () => {
    observer = createClient({ url: redisUrl });
    await observer.connect();
  });

  afterAll(async () => {
    const keys = await observer.keys(`${prefix}:*`);
    if (keys.length > 0) await observer.del(keys);
    await observer.quit();
  });

  it('control: an oversized MULTI leaves the connection stuck inside a transaction', async () => {
    const client = productionShapedClient();
    await client.connect();
    try {
      const transaction = client.multi();
      for (let index = 0; index < 1_200; index += 1) {
        transaction.setEx(`${prefix}:multi:${index}`, 60, 'v');
      }
      await expect(transaction.exec()).rejects.toThrow('The queue is full');

      // Once the queue has drained the connection accepts commands again — but
      // only into the transaction the server still holds open.
      const reply = await answerOnceDrained(() => client.set(`${prefix}:probe-multi`, 'value'));
      expect(reply).toBe('QUEUED');
      expect(await observer.get(`${prefix}:probe-multi`)).toBeNull();
    } finally {
      client.destroy();
    }
  });

  it('writes a batch larger than the queue, and the connection stays usable', async () => {
    const client = productionShapedClient();
    await client.connect();
    try {
      const entries = Array.from(
        { length: 1_500 },
        (_, index) => [`${prefix}:batch:${index}`, String(index)] as const,
      );

      await setExInBatches(client, entries, 60);

      expect(await observer.get(`${prefix}:batch:0`)).toBe('0');
      expect(await observer.get(`${prefix}:batch:1499`)).toBe('1499');
      expect(await observer.ttl(`${prefix}:batch:1499`)).toBeGreaterThan(0);
      await expect(client.set(`${prefix}:probe-batch`, 'value')).resolves.toBe('OK');
      expect(await observer.get(`${prefix}:probe-batch`)).toBe('value');
    } finally {
      client.destroy();
    }
  });
});
