/**
 * Oxy egress instrumentation.
 *
 * The label derivation is checked as a pure function, because the labels are
 * the difference between a useful metric and both a Prometheus cardinality
 * incident and a privacy leak — an Oxy path carries user ids, and an asset URL
 * carries a scoped `mt=` media token.
 *
 * The patch itself is checked against a real prototype chain rather than a
 * mocked one: the mechanism IS "replace a method on the prototype an instance
 * inherits from", so a stub that already exposes `request` as an own property
 * would confirm an implementation that reaches no real `OxyServices`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../config';
import { metrics } from '../../utils/metrics';
import {
  instrumentOxyEgress,
  isOxyInstrumentationEnabled,
  runWithOxyAccounting,
  templateOxyRoute,
} from '../../utils/oxyMetrics';

/**
 * The suite must not depend on the ambient `OXY_REQUEST_METRICS_ENABLED`, which
 * defaults OFF under `NODE_ENV=test`. It is set before any install, because the
 * prototype is patched once — flipping it afterwards would leave an unpatched
 * prototype and a green-looking test asserting nothing.
 */
let previousSetting = false;

beforeAll(() => {
  previousSetting = config.oxy.requestMetricsEnabled;
  config.oxy.requestMetricsEnabled = true;
});

afterAll(() => {
  config.oxy.requestMetricsEnabled = previousSetting;
});

beforeEach(() => {
  metrics.reset();
});

/** A stand-in for `HttpService`: `request` lives on the PROTOTYPE, as in the SDK. */
class FakeHttpService {
  constructor(private readonly behaviour: (url: string) => Promise<unknown>) {}

  async request(requestConfig: { method: string; url: string }): Promise<unknown> {
    return this.behaviour(requestConfig.url);
  }
}

function clientThatResolves(): { httpService: FakeHttpService } {
  return { httpService: new FakeHttpService(async () => ({ ok: true })) };
}

async function exposition(): Promise<string> {
  return metrics.getPrometheusFormat();
}

describe('templateOxyRoute', () => {
  it('replaces identifier segments and keeps route names', () => {
    expect(templateOxyRoute('/users/650000000000000000000010/following')).toBe(
      '/users/:id/following',
    );
    expect(templateOxyRoute('/users/me/graph')).toBe('/users/me/graph');
    expect(templateOxyRoute('/privacy/blocked/12345')).toBe('/privacy/blocked/:id');
    expect(
      templateOxyRoute('/assets/2b8f4e1c-9a0d-4f7b-8c31-5e6d7a8b9c01/stream'),
    ).toBe('/assets/:id/stream');
  });

  it('drops the query string, so a scoped media token cannot become a label', () => {
    expect(templateOxyRoute('/assets/650000000000000000000010?mt=secret-media-token')).toBe(
      '/assets/:id',
    );
    expect(templateOxyRoute('https://api.oxy.so/users/me/graph?fresh=1')).toBe(
      '/users/me/graph',
    );
  });

  it('collapses to /other once the template cap is reached', () => {
    // Distinct ROUTE NAMES, not ids — an id-bearing path templates down to a
    // shape that is already known, which is the whole point of the templating.
    const seen = new Set<string>();
    for (let index = 0; index < 60; index += 1) {
      seen.add(templateOxyRoute(`/synthetic-route-${String.fromCharCode(97 + index % 26)}${index}`));
    }
    expect(seen.has('/other')).toBe(true);
  });
});

describe('instrumentOxyEgress', () => {
  it('records a call against its templated route', async () => {
    const client = clientThatResolves();
    instrumentOxyEgress(client);

    await client.httpService.request({
      method: 'GET',
      url: '/users/650000000000000000000010/following',
    });

    expect(await exposition()).toContain(
      'oxy_calls_total{method="GET",route="/users/:id/following",status="2xx"} 1',
    );
  });

  it('never lets an identifier or a media token reach the registry', async () => {
    // The cardinality-and-privacy guard. Without templating both of these
    // appear verbatim as label values.
    const client = clientThatResolves();
    instrumentOxyEgress(client);

    await client.httpService.request({
      method: 'GET',
      url: '/assets/650000000000000000000010/stream?mt=secret-media-token',
    });

    const text = await exposition();
    expect(text).toContain('route="/assets/:id/stream"');
    expect(text).not.toContain('650000000000000000000010');
    expect(text).not.toContain('secret-media-token');
  });

  it('records a rejection under its status class and rethrows it', async () => {
    const failure = Object.assign(new Error('forbidden'), { status: 403 });
    const client = { httpService: new FakeHttpService(async () => { throw failure; }) };
    instrumentOxyEgress(client);

    await expect(
      client.httpService.request({ method: 'GET', url: '/users/me/graph' }),
    ).rejects.toThrow('forbidden');

    expect(await exposition()).toContain(
      'oxy_calls_total{method="GET",route="/users/me/graph",status="4xx"} 1',
    );
  });

  it('counts every call of one request against one tally', async () => {
    const client = clientThatResolves();
    instrumentOxyEgress(client);

    const tally = await runWithOxyAccounting(async (accumulated) => {
      // Awaited across three separate calls: the point of the async context is
      // that a call issued deep inside an awaited chain still lands here.
      await client.httpService.request({ method: 'GET', url: '/users/me/graph' });
      await client.httpService.request({ method: 'GET', url: '/users/me/graph' });
      await client.httpService.request({ method: 'GET', url: '/users/me/graph' });
      return accumulated;
    });

    expect(tally.count).toBe(3);
    expect(tally.errorCount).toBe(0);
    expect(tally.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('patches a prototype once, however many instances share it', async () => {
    const first = clientThatResolves();
    const second = clientThatResolves();
    instrumentOxyEgress(first);
    instrumentOxyEgress(second);

    // `second` was never installed against in any meaningful sense — it shares
    // `first`'s prototype — and it must still be measured, exactly once.
    await second.httpService.request({ method: 'GET', url: '/users/me/graph' });

    expect(await exposition()).toContain(
      'oxy_calls_total{method="GET",route="/users/me/graph",status="2xx"} 1',
    );
  });

  it('leaves the prototype untouched when the flag is off', async () => {
    config.oxy.requestMetricsEnabled = false;
    try {
      expect(isOxyInstrumentationEnabled()).toBe(false);

      // A fresh class, so this cannot ride on a prototype an earlier case patched.
      class UnpatchedHttpService {
        async request(_requestConfig: { method: string; url: string }): Promise<unknown> {
          return { ok: true };
        }
      }
      const client = { httpService: new UnpatchedHttpService() };
      const before = Object.getPrototypeOf(client.httpService).request;
      instrumentOxyEgress(client);
      expect(Object.getPrototypeOf(client.httpService).request).toBe(before);

      await client.httpService.request({ method: 'GET', url: '/users/me/graph' });
      // The metric FAMILY stays registered by earlier cases in this file, so the
      // invariant is that no sample was written — not that the name is absent.
      expect(await exposition()).not.toMatch(/^oxy_calls_total\{/m);
    } finally {
      config.oxy.requestMetricsEnabled = true;
    }
  });
});
