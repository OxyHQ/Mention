import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Cross-instance metrics aggregation.
 *
 * Production runs several ECS tasks behind an ALB, so `/metrics` must serve the
 * Redis-aggregated FLEET total rather than the fragment held by whichever task the
 * scrape happened to land on. These tests pin the four invariants that design rests
 * on:
 *
 *  1. The HOT PATH does zero I/O — incrementing a counter never touches Redis.
 *  2. The flusher batches every delta into ONE pipeline and resets the local deltas.
 *  3. `/metrics` renders the Redis aggregate (two "instances" ⇒ the sum).
 *  4. Redis down / not configured ⇒ fall back to the in-memory values, never throw.
 *
 * The Redis client is injected, so the suite exercises the real aggregator against a
 * faithful in-memory Redis instead of mocking the code under test. `../utils/redis`
 * is un-stubbed here (the global setup replaces it with an always-unavailable client)
 * so the REDIS_URL gate itself can be asserted for real.
 */
vi.mock('../utils/redis', async (importOriginal) => await importOriginal<typeof import('../utils/redis')>());

import { MetricsAggregator, type MetricsRedisClient, type MetricsRedisMulti } from '../services/metricsAggregator';
import { MetricsCollector } from '../utils/metrics';
import { isRedisConfigured } from '../utils/redis';
import { FEED_METRICS, recordPoolCandidates } from '../mtn/feed/feedMetrics';

type QueuedCommand = () => unknown;

/**
 * An in-memory stand-in for the shared node-redis client, implementing exactly the
 * surface the aggregator uses. It counts every interaction so a test can assert the
 * client was never touched at all.
 */
class FakeRedis implements MetricsRedisClient {
  isReady = true;
  /** Set by a test to make `exec()` reject, simulating a mid-flush Redis failure. */
  failOnExec = false;

  readonly hashes = new Map<string, Map<string, number>>();
  readonly sets = new Map<string, Set<string>>();
  readonly expiries = new Map<string, number>();

  multiCalls = 0;
  execCalls = 0;
  sMembersCalls = 0;
  commandsQueued = 0;

  /** Every interaction with this client (used to prove the hot path is I/O-free). */
  get totalCalls(): number {
    return this.multiCalls + this.execCalls + this.sMembersCalls + this.commandsQueued;
  }

  async sMembers(key: string): Promise<string[]> {
    this.sMembersCalls += 1;
    return [...(this.sets.get(key) ?? [])];
  }

  multi(): MetricsRedisMulti {
    this.multiCalls += 1;
    const queue: QueuedCommand[] = [];
    const client = this;

    const chain: MetricsRedisMulti = {
      sAdd(key: string, members: string[]): MetricsRedisMulti {
        client.commandsQueued += 1;
        queue.push(() => {
          const set = client.sets.get(key) ?? new Set<string>();
          client.sets.set(key, set);
          for (const member of members) set.add(member);
          return members.length;
        });
        return chain;
      },
      hIncrBy(key: string, field: string, increment: number): MetricsRedisMulti {
        client.commandsQueued += 1;
        queue.push(() => {
          const hash = client.hashes.get(key) ?? new Map<string, number>();
          client.hashes.set(key, hash);
          const next = (hash.get(field) ?? 0) + increment;
          hash.set(field, next);
          return next;
        });
        return chain;
      },
      expire(key: string, seconds: number): MetricsRedisMulti {
        client.commandsQueued += 1;
        queue.push(() => {
          client.expiries.set(key, seconds);
          return 1;
        });
        return chain;
      },
      hGetAll(key: string): MetricsRedisMulti {
        client.commandsQueued += 1;
        queue.push(() => {
          const hash = client.hashes.get(key);
          if (!hash) return {};
          return Object.fromEntries([...hash.entries()].map(([field, value]) => [field, String(value)]));
        });
        return chain;
      },
      async exec(): Promise<unknown[]> {
        client.execCalls += 1;
        if (client.failOnExec) {
          throw new Error('READONLY You can not write against a read only replica.');
        }
        return queue.map((command) => command());
      },
    };

    return chain;
  }
}

/** Build an aggregator bound to `collector` + `redis`, with Redis considered available. */
function aggregatorFor(collector: MetricsCollector, redis: FakeRedis, flushIntervalMs = 10_000): MetricsAggregator {
  return new MetricsAggregator({
    collector,
    getClient: () => redis,
    isEnabled: () => true,
    flushIntervalMs,
    keyTtlSeconds: 60,
  });
}

/** Read one counter series out of a rendered Prometheus document. */
function seriesValue(document: string, series: string): number | undefined {
  const line = document.split('\n').find((candidate) => candidate.startsWith(`${series} `));
  if (!line) return undefined;
  return Number(line.slice(series.length + 1));
}

const IMPRESSION_LOCAL = `${FEED_METRICS.impression}{descriptor="for_you",origin="local"}`;
const POOL_FEDERATED = `${FEED_METRICS.poolCandidates}{descriptor="for_you",origin="federated"}`;
const POOL_LOCAL = `${FEED_METRICS.poolCandidates}{descriptor="for_you",origin="local"}`;

let collector: MetricsCollector;
let redis: FakeRedis;
let aggregator: MetricsAggregator;

beforeEach(() => {
  collector = new MetricsCollector();
  redis = new FakeRedis();
  aggregator = aggregatorFor(collector, redis);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hot path', () => {
  it('performs ZERO Redis calls while recording counters', () => {
    aggregator.start();

    for (let i = 0; i < 500; i += 1) {
      collector.incrementCounter(FEED_METRICS.discoveryGated, 1, {
        reason: 'lowEffortGate',
        source: 'trending',
        shadow: 'true',
      });
      collector.incrementCounter(FEED_METRICS.impression, 1, { origin: 'local', descriptor: 'for_you' });
    }

    expect(redis.totalCalls).toBe(0);
    expect(collector.getCounter(FEED_METRICS.impression, { origin: 'local', descriptor: 'for_you' })).toBe(500);
  });
});

describe('flusher', () => {
  it('batches every delta into ONE pipeline and resets the local deltas', async () => {
    collector.incrementCounter(FEED_METRICS.impression, 1, { origin: 'local', descriptor: 'for_you' });
    collector.incrementCounter(FEED_METRICS.impression, 1, { origin: 'local', descriptor: 'for_you' });
    collector.incrementCounter(FEED_METRICS.impression, 1, { origin: 'federated', descriptor: 'for_you' });
    collector.incrementCounter(FEED_METRICS.report, 1, { descriptor: 'for_you', origin: 'local' });

    await aggregator.flush();

    // One pipeline, one round trip — regardless of how many series were touched.
    expect(redis.multiCalls).toBe(1);
    expect(redis.execCalls).toBe(1);

    // 3 series → 3 HINCRBY; plus the registry SADD and the 3 refreshed expiries
    // (registry + one per metric name).
    expect(redis.commandsQueued).toBe(3 + 1 + 1 + 2);

    expect(redis.hashes.get(`metrics:counter:${FEED_METRICS.impression}`)).toEqual(
      new Map([
        ['{descriptor="for_you",origin="local"}', 2],
        ['{descriptor="for_you",origin="federated"}', 1],
      ]),
    );
    expect(redis.sets.get('metrics:counters')).toEqual(
      new Set([FEED_METRICS.impression, FEED_METRICS.report]),
    );

    // Local deltas were reset: a flush with nothing new opens no pipeline at all.
    await aggregator.flush();
    expect(redis.multiCalls).toBe(1);
    expect(redis.execCalls).toBe(1);

    // ...while the local running total is untouched (it is the fallback view).
    expect(collector.getCounter(FEED_METRICS.impression, { origin: 'local', descriptor: 'for_you' })).toBe(2);
  });

  it('pushes deltas on the configured interval', async () => {
    vi.useFakeTimers();
    aggregator.start();

    collector.incrementCounter(FEED_METRICS.impression, 1, { origin: 'local', descriptor: 'for_you' });
    expect(redis.execCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(redis.execCalls).toBe(1);
    expect(redis.hashes.get(`metrics:counter:${FEED_METRICS.impression}`)?.get('{descriptor="for_you",origin="local"}')).toBe(1);

    await aggregator.stop();
  });

  it('only flushes the DELTA, never the running total (counters stay monotonic in Redis)', async () => {
    collector.incrementCounter(FEED_METRICS.impression, 3, { origin: 'local', descriptor: 'for_you' });
    await aggregator.flush();

    collector.incrementCounter(FEED_METRICS.impression, 2, { origin: 'local', descriptor: 'for_you' });
    await aggregator.flush();

    // 3 + 2 — not 3 + 5 (which is what flushing the local total would have written).
    expect(redis.hashes.get(`metrics:counter:${FEED_METRICS.impression}`)?.get('{descriptor="for_you",origin="local"}')).toBe(5);
  });
});

describe('GET /metrics rendering', () => {
  it('renders the Redis aggregate across instances (two tasks ⇒ the sum)', async () => {
    // Two tasks = two collectors with their own aggregator, one shared Redis.
    const collectorB = new MetricsCollector();
    const aggregatorB = aggregatorFor(collectorB, redis);

    for (let i = 0; i < 2; i += 1) {
      collector.incrementCounter(FEED_METRICS.impression, 1, { origin: 'local', descriptor: 'for_you' });
    }
    for (let i = 0; i < 3; i += 1) {
      collectorB.incrementCounter(FEED_METRICS.impression, 1, { origin: 'local', descriptor: 'for_you' });
    }

    await aggregator.flush();
    await aggregatorB.flush();

    // A scrape landing on EITHER task sees the fleet total.
    const fromA = await aggregator.renderPrometheus();
    const fromB = await aggregatorB.renderPrometheus();

    expect(seriesValue(fromA, IMPRESSION_LOCAL)).toBe(5);
    expect(seriesValue(fromB, IMPRESSION_LOCAL)).toBe(5);
    expect(fromA).toContain(`# TYPE ${FEED_METRICS.impression} counter`);
  });

  it('flushes this task\'s pending deltas before reading, so a scrape is never stale', async () => {
    collector.incrementCounter(FEED_METRICS.impression, 4, { origin: 'local', descriptor: 'for_you' });

    // No explicit flush: the scrape itself must publish the pending deltas.
    const document = await aggregator.renderPrometheus();

    expect(seriesValue(document, IMPRESSION_LOCAL)).toBe(4);
  });

  it('derives the correct federated share from the two pool counters across instances', async () => {
    // Task A merged a pool of 1 federated + 3 local (share 0.25); task B, 3 federated
    // + 1 local (share 0.75). Fleet-wide the truth is 4 of 8 ⇒ 0.5 — a number the old
    // per-request GAUGE could never produce (a scrape saw one task's last write).
    const collectorB = new MetricsCollector();
    const aggregatorB = aggregatorFor(collectorB, redis);

    const recordPool = (target: MetricsCollector, federated: number, local: number): void => {
      target.incrementCounter(FEED_METRICS.poolCandidates, federated, { descriptor: 'for_you', origin: 'federated' });
      target.incrementCounter(FEED_METRICS.poolCandidates, local, { descriptor: 'for_you', origin: 'local' });
    };

    recordPool(collector, 1, 3);
    recordPool(collectorB, 3, 1);

    await aggregator.flush();
    await aggregatorB.flush();

    const document = await aggregator.renderPrometheus();
    const federated = seriesValue(document, POOL_FEDERATED) ?? 0;
    const local = seriesValue(document, POOL_LOCAL) ?? 0;

    expect(federated).toBe(4);
    expect(local).toBe(4);
    expect(federated / (federated + local)).toBeCloseTo(0.5, 5);
  });
});

describe('fail-soft', () => {
  it('falls back to the in-memory values when Redis is not ready, and retains the deltas', async () => {
    redis.isReady = false;
    collector.incrementCounter(FEED_METRICS.impression, 7, { origin: 'local', descriptor: 'for_you' });

    await expect(aggregator.flush()).resolves.toBeUndefined();

    const document = await aggregator.renderPrometheus();
    expect(seriesValue(document, IMPRESSION_LOCAL)).toBe(7); // this task's own total
    expect(redis.hashes.size).toBe(0);

    // Nothing was lost: once Redis recovers, the retained delta lands in full.
    redis.isReady = true;
    await aggregator.flush();
    expect(redis.hashes.get(`metrics:counter:${FEED_METRICS.impression}`)?.get('{descriptor="for_you",origin="local"}')).toBe(7);
  });

  it('never throws when the pipeline fails, and retries the deltas on the next flush', async () => {
    redis.failOnExec = true;
    collector.incrementCounter(FEED_METRICS.impression, 2, { origin: 'local', descriptor: 'for_you' });

    await expect(aggregator.flush()).resolves.toBeUndefined();
    expect(redis.hashes.size).toBe(0);

    collector.incrementCounter(FEED_METRICS.impression, 3, { origin: 'local', descriptor: 'for_you' });
    redis.failOnExec = false;
    await aggregator.flush();

    // The failed delta (2) was retried alongside the new one (3).
    expect(redis.hashes.get(`metrics:counter:${FEED_METRICS.impression}`)?.get('{descriptor="for_you",origin="local"}')).toBe(5);
  });

  it('never throws when the read fails mid-scrape', async () => {
    collector.incrementCounter(FEED_METRICS.impression, 1, { origin: 'local', descriptor: 'for_you' });
    await aggregator.flush();

    redis.failOnExec = true;
    const document = await aggregator.renderPrometheus();

    expect(seriesValue(document, IMPRESSION_LOCAL)).toBe(1); // in-memory fallback
  });
});

describe('Redis not configured', () => {
  const originalUrl = process.env.REDIS_URL;
  const originalUri = process.env.REDIS_URI;
  const originalHost = process.env.REDIS_HOST;

  afterEach(() => {
    process.env.REDIS_URL = originalUrl;
    process.env.REDIS_URI = originalUri;
    process.env.REDIS_HOST = originalHost;
    if (originalUrl === undefined) delete process.env.REDIS_URL;
    if (originalUri === undefined) delete process.env.REDIS_URI;
    if (originalHost === undefined) delete process.env.REDIS_HOST;
  });

  it('reports Redis as unconfigured when REDIS_URL/REDIS_URI/REDIS_HOST are unset', () => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_URI;
    delete process.env.REDIS_HOST;
    expect(isRedisConfigured()).toBe(false);

    process.env.REDIS_URL = 'redis://localhost:6379';
    expect(isRedisConfigured()).toBe(true);
  });

  it('keeps working in-memory: start/flush/stop are no-ops and /metrics still renders', async () => {
    const disabled = new MetricsAggregator({
      collector,
      getClient: () => redis,
      isEnabled: () => false,
      flushIntervalMs: 10_000,
      keyTtlSeconds: 60,
    });

    disabled.start();
    collector.incrementCounter(FEED_METRICS.impression, 9, { origin: 'local', descriptor: 'for_you' });
    await disabled.flush();

    const document = await disabled.renderPrometheus();
    expect(seriesValue(document, IMPRESSION_LOCAL)).toBe(9);
    expect(redis.totalCalls).toBe(0); // the client was never even asked for

    await disabled.stop();
  });
});

describe('feedMetrics emitters feed the aggregator', () => {
  it('flushes what recordPoolCandidates emitted on the process singleton', async () => {
    const { metrics: singleton } = await import('../utils/metrics');
    singleton.reset();

    const singletonAggregator = new MetricsAggregator({
      getClient: () => redis,
      isEnabled: () => true,
      flushIntervalMs: 10_000,
      keyTtlSeconds: 60,
    });

    recordPoolCandidates('for_you', 2, 6);
    await singletonAggregator.flush();

    const document = await singletonAggregator.renderPrometheus();
    expect(seriesValue(document, POOL_FEDERATED)).toBe(2);
    expect(seriesValue(document, POOL_LOCAL)).toBe(6);

    singleton.reset();
  });
});
