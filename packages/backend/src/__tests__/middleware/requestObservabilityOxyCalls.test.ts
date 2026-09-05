/**
 * The join between `requestObservability` and the Oxy egress instrumentation —
 * the number that decides whether a slow route is slow in Postgres or slow
 * waiting on Oxy, which no existing signal could distinguish.
 *
 * Served by a real Express app, because the mechanism is an `AsyncLocalStorage`
 * context opened before `next()` and read on `finish`. Calling the middleware
 * directly would not exercise the part that can actually break: whether the
 * context survives the handler's awaits — the calls it has to count are issued
 * several service layers below the middleware that reports them.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config';
import { requestObservability } from '../../middleware/requestObservability';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';
import { instrumentOxyEgress } from '../../utils/oxyMetrics';

/** A stand-in for `HttpService`: `request` lives on the PROTOTYPE, as in the SDK. */
class FakeHttpService {
  async request(requestConfig: { method: string; url: string }): Promise<unknown> {
    return { url: requestConfig.url };
  }
}

const oxyClient = { httpService: new FakeHttpService() };

/**
 * The flag is set BEFORE the install, because the prototype is patched once —
 * flipping it afterwards would leave an unpatched prototype and a green-looking
 * test asserting nothing.
 */
let previousSetting = false;

beforeAll(() => {
  previousSetting = config.oxy.requestMetricsEnabled;
  config.oxy.requestMetricsEnabled = true;
  instrumentOxyEgress(oxyClient);
});

afterAll(() => {
  config.oxy.requestMetricsEnabled = previousSetting;
});

beforeEach(() => {
  metrics.reset();
  vi.clearAllMocks();
});

const app = express();
app.use(requestObservability);
app.get('/feed/item/:id', async (_req, res) => {
  // Nested behind two awaits on purpose: a context that only survived the
  // handler's own frame would still pass a flat version of this test.
  await (async () => {
    await (async () => {
      await oxyClient.httpService.request({ method: 'GET', url: '/users/me/graph' });
      await oxyClient.httpService.request({
        method: 'GET',
        url: '/users/650000000000000000000010/followers',
      });
    })();
  })();
  res.status(200).json({ ok: true });
});
app.get('/static', (_req, res) => res.status(200).json({ ok: true }));

/** The completion line the middleware logs, whatever else the run logged. */
function completionContext(): Record<string, unknown> {
  const call = vi
    .mocked(logger.info)
    .mock.calls.find(([message]) => message === 'HTTP request completed');
  expect(call).toBeDefined();
  return call?.[1] as Record<string, unknown>;
}

describe('per-request Oxy accounting', () => {
  it('reports the Oxy calls a request made and the time they took', async () => {
    await request(app).get('/feed/item/abc').expect(200);

    const context = completionContext();
    expect(context.oxyCallCount).toBe(2);
    expect(context.failedOxyCallCount).toBe(0);
    // The request cannot have spent more time waiting on Oxy than it took.
    expect(Number(context.oxyDurationMs)).toBeLessThanOrEqual(Number(context.durationMs));
  });

  it('reports zero for a request that never calls Oxy', async () => {
    // The control. Without it, `oxyCallCount: 2` above is equally satisfied by a
    // counter that reports 2 for every request, or by one that never resets
    // between requests.
    await request(app).get('/static').expect(200);

    expect(completionContext().oxyCallCount).toBe(0);
  });

  it('does not carry one request’s calls into the next', async () => {
    await request(app).get('/feed/item/abc').expect(200);
    vi.clearAllMocks();
    await request(app).get('/feed/item/def').expect(200);

    expect(completionContext().oxyCallCount).toBe(2);
  });

  it('publishes the count and the Oxy time under the route template', async () => {
    await request(app).get('/feed/item/abc').expect(200);

    const exposition = await metrics.getPrometheusFormat();
    expect(exposition).toContain(
      'oxy_request_calls_count{method="GET",route="/feed/item/:id"} 1',
    );
    expect(exposition).toContain(
      'oxy_request_calls_sum{method="GET",route="/feed/item/:id"} 2',
    );
    expect(exposition).toContain(
      'oxy_request_duration_ms_count{method="GET",route="/feed/item/:id"} 1',
    );
  });
});
