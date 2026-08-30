/**
 * The join between `requestObservability` and the query instrumentation — the
 * number the efficiency programme is built on: how many database round trips
 * one HTTP request made.
 *
 * Served by a real Express app over a real pool, because the mechanism is an
 * `AsyncLocalStorage` context opened before `next()` and read on `finish`. A
 * unit test that called the middleware directly would not exercise the part
 * that can actually break: whether the context survives the handler's awaits.
 */

import express from 'express';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { requestObservability } from '../../middleware/requestObservability';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';

let db: Database;

const app = express();
app.use(requestObservability);
app.get('/posts/:id', async (_req, res) => {
  await db.execute(sql`select 1`);
  await db.execute(sql`select 2`);
  res.status(200).json({ ok: true });
});
app.get('/static', (_req, res) => res.status(200).json({ ok: true }));

/**
 * The suite must not depend on the ambient `DB_QUERY_METRICS_ENABLED`. The flag
 * is set BEFORE `connectPostgres()` rather than inside a case, because the
 * client is patched once at connect time — flipping it afterwards would leave
 * an unpatched pool and a green-looking test asserting nothing.
 */
let previousInstrumentationSetting = false;

beforeAll(async () => {
  previousInstrumentationSetting = config.postgres.queryMetricsEnabled;
  config.postgres.queryMetricsEnabled = true;
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
  config.postgres.queryMetricsEnabled = previousInstrumentationSetting;
});

beforeEach(() => {
  metrics.reset();
  vi.clearAllMocks();
});

/** The completion line the middleware logs, whatever else the run logged. */
function completionContext(): Record<string, unknown> {
  const call = vi
    .mocked(logger.info)
    .mock.calls.find(([message]) => message === 'HTTP request completed');
  expect(call).toBeDefined();
  return call?.[1] as Record<string, unknown>;
}

describe('per-request query accounting', () => {
  it('reports the round trips a request made and the time they took', async () => {
    await request(app).get('/posts/abc').expect(200);

    const context = completionContext();
    expect(context.queryCount).toBe(2);
    expect(context.queryDurationMs).toBeGreaterThan(0);
    expect(context.slowQueryCount).toBe(0);
    expect(context.failedQueryCount).toBe(0);
    // The request cannot have spent more time in the database than it took.
    expect(context.queryDurationMs).toBeLessThanOrEqual(Number(context.durationMs));
  });

  it('publishes the count and the database time under the route template', async () => {
    await request(app).get('/posts/abc').expect(200);

    const exposition = await metrics.getPrometheusFormat();
    expect(exposition).toMatch(
      /^db_request_queries_sum\{method="GET",route="\/posts\/:id"\} 2$/m,
    );
    expect(exposition).toMatch(
      /^db_request_duration_ms_count\{method="GET",route="\/posts\/:id"\} 1$/m,
    );
  });

  it('reports zero for a request that never touched the database', async () => {
    await request(app).get('/static').expect(200);

    expect(completionContext().queryCount).toBe(0);
  });

  it('keeps two concurrent requests from sharing a tally', async () => {
    await Promise.all([
      request(app).get('/posts/one').expect(200),
      request(app).get('/posts/two').expect(200),
    ]);

    const counts = vi
      .mocked(logger.info)
      .mock.calls.filter(([message]) => message === 'HTTP request completed')
      .map(([, context]) => (context as Record<string, unknown>).queryCount);
    expect(counts).toEqual([2, 2]);
  });

  it('omits the database fields entirely when instrumentation is disabled', async () => {
    const previous = config.postgres.queryMetricsEnabled;
    config.postgres.queryMetricsEnabled = false;
    try {
      await request(app).get('/static').expect(200);
    } finally {
      config.postgres.queryMetricsEnabled = previous;
    }

    const context = completionContext();
    expect(context).not.toHaveProperty('queryCount');
    // The request's own telemetry is untouched by the switch.
    expect(context).toMatchObject({ route: '/static', statusCode: 200 });
    expect(await metrics.getPrometheusFormat()).not.toContain('db_request_queries_count');
  });
});
