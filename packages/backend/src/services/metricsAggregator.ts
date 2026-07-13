/**
 * Cross-instance metrics aggregation.
 *
 * Production runs several backend tasks behind an ALB, so a `GET /metrics` scrape
 * lands on ONE arbitrary task. With purely in-memory counters each task holds a
 * fragment of the truth and the aggregate is unreadable — a counter that is absent
 * from a scrape is indistinguishable from a counter that never fired. This service
 * makes `/metrics` serve the fleet-wide total.
 *
 * Design:
 *  - The WRITE path stays exactly as it was: `metrics.incrementCounter` is a Map
 *    update. No Redis call ever happens on a request (the discovery gate increments
 *    a counter per rejected candidate, ~150 per feed request — a round trip there
 *    would be a catastrophic regression).
 *  - A PERIODIC FLUSHER (every `config.metrics.flushIntervalMs`, on EVERY task —
 *    deliberately NOT leader-gated, each task owns its own deltas) drains the
 *    counter increments accumulated since the last tick and pushes them to Redis in
 *    a SINGLE pipeline: one `HINCRBY` per counter series. Batched, bounded by the
 *    number of distinct series (low-cardinality by discipline), off the request path.
 *  - `GET /metrics` reads the Redis aggregate (`SMEMBERS` of the registry + one
 *    `HGETALL` per registered metric, pipelined) and renders Prometheus format.
 *
 * Storage:
 *  - `metrics:counter:<name>` — HASH; field = the canonical serialized label set
 *    (`{origin="local"}`, empty for unlabelled), value = the running total.
 *  - `metrics:counters` — SET of registered metric names, so the read path never
 *    has to scan the keyspace.
 *  Counters are MONOTONIC and are never reset in Redis: a redeploy resets local
 *  memory while Redis keeps the running total, which is precisely the semantics
 *  Prometheus expects of a counter. The only expiry is a long, refreshed-on-every-
 *  flush TTL that reclaims keys for metrics no longer emitted by any task.
 *
 * Failure behaviour (fail-soft, always):
 *  - Redis unavailable or not configured → `/metrics` serves the in-memory values
 *    (the previous behaviour) and drained deltas are handed back to the collector so
 *    they are retried on the next tick rather than lost. Nothing throws, no request
 *    is broken, the feed is never blocked. The first failure of an outage logs at
 *    `warn` (subsequent ones stay quiet until the next success).
 *
 * Gauges and histograms are point-in-time / per-process values that cannot be summed
 * across instances, so they are intentionally NOT aggregated and remain per-task in
 * the exposition. Any quantity that must survive aggregation has to be modelled as a
 * counter (see `feed_pool_candidates_total`).
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { metrics, MetricsCollector, type CounterSample } from '../utils/metrics';
import { getRedisClient, isRedisConfigured } from '../utils/redis';

/** Key prefix for the per-metric counter HASH. */
const COUNTER_KEY_PREFIX = 'metrics:counter:';

/** SET holding every counter metric name that has ever been flushed. */
const COUNTER_REGISTRY_KEY = 'metrics:counters';

/** The queued-command surface the aggregator needs from a Redis pipeline. */
export interface MetricsRedisMulti {
  sAdd(key: string, members: string[]): MetricsRedisMulti;
  hIncrBy(key: string, field: string, increment: number): MetricsRedisMulti;
  expire(key: string, seconds: number): MetricsRedisMulti;
  hGetAll(key: string): MetricsRedisMulti;
  exec(): Promise<unknown[]>;
}

/**
 * The minimal Redis surface the aggregator needs. Narrow by design: the shared
 * node-redis client satisfies it structurally, and tests can supply a fake without
 * reconstructing the full client type.
 */
export interface MetricsRedisClient {
  readonly isReady: boolean;
  sMembers(key: string): Promise<string[]>;
  multi(): MetricsRedisMulti;
}

export interface MetricsAggregatorOptions {
  /** Collector to drain. Defaults to the process-wide `metrics` singleton. */
  collector?: MetricsCollector;
  /** Redis client provider. Defaults to the shared app client (no new connection). */
  getClient?: () => MetricsRedisClient;
  /** Whether Redis aggregation is available. Defaults to "a Redis target is configured". */
  isEnabled?: () => boolean;
  flushIntervalMs?: number;
  keyTtlSeconds?: number;
}

/** Redis key holding a metric's counter series. */
function counterKey(metricName: string): string {
  return `${COUNTER_KEY_PREFIX}${metricName}`;
}

/** Narrow an `HGETALL` reply to the field→value map it is documented to be. */
function asHashReply(reply: unknown): Record<string, string> | null {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null;
  const entries = Object.entries(reply as Record<string, unknown>);
  const hash: Record<string, string> = {};
  for (const [field, value] of entries) {
    if (typeof value !== 'string') return null;
    hash[field] = value;
  }
  return hash;
}

export class MetricsAggregator {
  private readonly collector: MetricsCollector;
  private readonly getClient: () => MetricsRedisClient;
  private readonly isEnabled: () => boolean;
  private readonly flushIntervalMs: number;
  private readonly keyTtlSeconds: number;

  private interval: ReturnType<typeof setInterval> | null = null;
  /** In-flight flush, so a scrape-triggered flush never races the timer's. */
  private inFlightFlush: Promise<void> | null = null;
  /** True once an outage has been logged; reset on the next success (no log spam). */
  private hasLoggedFailure = false;

  constructor(options: MetricsAggregatorOptions = {}) {
    this.collector = options.collector ?? metrics;
    this.getClient = options.getClient ?? (() => getRedisClient());
    this.isEnabled = options.isEnabled ?? (() => isRedisConfigured());
    this.flushIntervalMs = options.flushIntervalMs ?? config.metrics.flushIntervalMs;
    this.keyTtlSeconds = options.keyTtlSeconds ?? config.metrics.redisKeyTtlSeconds;
  }

  /**
   * Start the periodic flusher. Runs on EVERY task (not leader-gated — each task
   * must publish its own deltas). Idempotent; a no-op when Redis is not configured,
   * in which case metrics simply stay in-memory and per-instance.
   */
  start(): void {
    if (this.interval) return;

    if (!this.isEnabled()) {
      logger.info('[Metrics] Redis not configured — metrics stay in-memory (per-instance only)');
      return;
    }

    this.interval = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Never keep the event loop alive on the flusher's account.
    this.interval.unref?.();

    logger.info(`[Metrics] cross-instance aggregation enabled (flushing counter deltas every ${this.flushIntervalMs}ms)`);
  }

  /**
   * Stop the flusher and push whatever this task accumulated since the last tick,
   * so a rolling deploy does not drop the final window. Idempotent; never throws.
   */
  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    await this.flush();
  }

  /**
   * Push the counter deltas accumulated since the last flush to Redis in one
   * pipeline. Never throws. Concurrent callers share the in-flight flush.
   */
  async flush(): Promise<void> {
    if (!this.isEnabled()) return;
    if (this.inFlightFlush) return this.inFlightFlush;

    const flushing = this.runFlush().finally(() => {
      this.inFlightFlush = null;
    });
    this.inFlightFlush = flushing;
    return flushing;
  }

  /**
   * Render the Prometheus exposition. Serves the Redis (fleet-wide) counter totals
   * plus this task's histograms/gauges. Falls back to the purely in-memory document
   * when Redis is unavailable. Never throws.
   */
  async renderPrometheus(): Promise<string> {
    if (!this.isEnabled()) {
      return this.collector.getPrometheusFormat();
    }

    try {
      // Publish this task's pending deltas first so a scrape is never up to one
      // flush interval stale about the instance it landed on.
      await this.flush();

      const samples = await this.readCounterSamples();
      if (samples === null) {
        return this.collector.getPrometheusFormat();
      }
      return this.collector.buildPrometheusDocument(samples);
    } catch (error) {
      this.logFailure('metrics read failed — serving in-memory values for this instance', error);
      return this.collector.getPrometheusFormat();
    }
  }

  /** One flush attempt: drain → single pipeline → restore the deltas on failure. */
  private async runFlush(): Promise<void> {
    const deltas = this.collector.drainCounterDeltas();
    if (deltas.length === 0) return;

    try {
      const client = this.getClient();
      if (!client.isReady) {
        this.collector.restoreCounterDeltas(deltas);
        this.logFailure('Redis not ready — counter deltas retained for the next flush', null);
        return;
      }

      const names = [...new Set(deltas.map((delta) => delta.name))];
      const multi = client.multi();

      // Registry: `/metrics` reads it instead of scanning the keyspace.
      multi.sAdd(COUNTER_REGISTRY_KEY, names);
      multi.expire(COUNTER_REGISTRY_KEY, this.keyTtlSeconds);

      for (const delta of deltas) {
        multi.hIncrBy(counterKey(delta.name), delta.labelSet, delta.value);
      }
      for (const name of names) {
        multi.expire(counterKey(name), this.keyTtlSeconds);
      }

      await multi.exec();
      this.hasLoggedFailure = false;
    } catch (error) {
      // Counters are additive: handing the deltas back means the next successful
      // flush still lands the full count. Nothing is lost to a transient outage.
      this.collector.restoreCounterDeltas(deltas);
      this.logFailure('counter flush failed — deltas retained for the next flush', error);
    }
  }

  /**
   * Read every registered counter series from Redis. Returns `null` when Redis is
   * not ready, signalling the caller to fall back to the in-memory document.
   */
  private async readCounterSamples(): Promise<CounterSample[] | null> {
    const client = this.getClient();
    if (!client.isReady) {
      this.logFailure('Redis not ready — serving in-memory values for this instance', null);
      return null;
    }

    const names = (await client.sMembers(COUNTER_REGISTRY_KEY)).sort();
    if (names.length === 0) return [];

    const multi = client.multi();
    for (const name of names) {
      multi.hGetAll(counterKey(name));
    }
    const replies = await multi.exec();

    const samples: CounterSample[] = [];
    names.forEach((name, index) => {
      const hash = asHashReply(replies[index]);
      if (!hash) return;
      for (const [labelSet, raw] of Object.entries(hash)) {
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        samples.push({ name, labelSet, value });
      }
    });

    this.hasLoggedFailure = false;
    return samples;
  }

  /** Log the FIRST failure of an outage at warn; stay quiet until the next success. */
  private logFailure(message: string, error: unknown): void {
    if (this.hasLoggedFailure) return;
    this.hasLoggedFailure = true;

    if (error instanceof Error) {
      logger.warn(`[Metrics] ${message}`, { error: error.message });
      return;
    }
    logger.warn(`[Metrics] ${message}`);
  }
}

/** Process-wide aggregator, started on every task at boot (see `server.ts`). */
export const metricsAggregator = new MetricsAggregator();
