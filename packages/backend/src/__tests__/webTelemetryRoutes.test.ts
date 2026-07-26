import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createWebTelemetryRouter,
  normalizeWebTelemetryRoute,
} from '../routes/webTelemetry.routes';
import { metrics } from '../utils/metrics';

describe('web RUM telemetry', () => {
  const app = express();
  app.use(express.json());
  app.use(createWebTelemetryRouter());

  beforeEach(() => {
    metrics.reset();
  });

  it('records bounded Core Web Vitals and runtime events without raw route ids', async () => {
    await request(app)
      .post('/telemetry/web')
      .set('origin', 'http://localhost:8081')
      .send({
        events: [
          {
            type: 'vital',
            name: 'LCP',
            value: 2_123,
            rating: 'good',
            navigation: 'navigate',
            route: '/p/507f1f77bcf86cd799439011?secret=value',
          },
          {
            type: 'runtime',
            kind: 'navigation',
            result: 'ok',
            route: '/@alice',
          },
        ],
      })
      .expect(204);

    const output = await metrics.getPrometheusFormat();
    expect(output).toContain('web_vital_lcp_ms');
    expect(output).toContain('route="/post"');
    expect(output).toContain('route="/profile"');
    expect(output).not.toContain('507f1f77bcf86cd799439011');
    expect(output).not.toContain('alice');
    expect(output).not.toContain('secret');
  });

  it('rejects malformed batches and untrusted origins', async () => {
    await request(app)
      .post('/telemetry/web')
      .set('origin', 'https://evil.example')
      .send({ events: [] })
      .expect(403);

    await request(app)
      .post('/telemetry/web')
      .set('origin', 'http://localhost:8081')
      .send({ events: [{ type: 'vital', name: 'LCP', value: -1 }] })
      .expect(400);
  });

  it('accepts a sendBeacon-compatible text payload', async () => {
    await request(app)
      .post('/telemetry/web')
      .set('origin', 'http://localhost:8081')
      .set('content-type', 'text/plain;charset=UTF-8')
      .send(JSON.stringify({
        events: [{
          type: 'runtime',
          kind: 'navigation',
          result: 'ok',
          route: '/p/private-id',
        }],
      }))
      .expect(204);

    const output = await metrics.getPrometheusFormat();
    expect(output).toContain('web_runtime_events_total');
    expect(output).toContain('route="/post"');
    expect(output).not.toContain('private-id');
  });

  it('accepts same-origin-style development requests without an Origin header', async () => {
    await request(app)
      .post('/telemetry/web')
      .send({
        events: [{
          type: 'runtime',
          kind: 'load',
          result: 'ok',
          route: '/',
        }],
      })
      .expect(204);
  });

  it('rejects malformed text payloads without throwing', async () => {
    await request(app)
      .post('/telemetry/web')
      .set('origin', 'http://localhost:8081')
      .set('content-type', 'text/plain')
      .send('{not-json')
      .expect(400, { message: 'Invalid telemetry batch' });
  });

  it('records every bounded vital family and drops impossible outliers', async () => {
    await request(app)
      .post('/telemetry/web')
      .set('origin', 'http://localhost:8081')
      .send({
        events: [
          {
            type: 'vital',
            name: 'CLS',
            value: 0.08,
            rating: 'good',
            navigation: 'reload',
            route: '/compose/new',
          },
          {
            type: 'vital',
            name: 'INP',
            value: 180,
            rating: 'needs-improvement',
            navigation: 'back-forward',
            route: '/search?q=private',
          },
          {
            type: 'vital',
            name: 'LCP',
            value: 120_001,
            rating: 'poor',
            navigation: 'other',
            route: '/videos/secret',
          },
        ],
      })
      .expect(204);

    const output = await metrics.getPrometheusFormat();
    expect(output).toContain('web_vital_cls_ratio');
    expect(output).toContain('web_vital_inp_ms');
    expect(output).not.toContain('120001');
    expect(output).not.toContain('secret');
  });

  it('normalizes dynamic application paths to a finite route vocabulary', () => {
    expect([
      '/',
      '/compose/new',
      '/explore/topic',
      '/feed/following',
      '/feeds/abc',
      '/oauth/callback',
      '/p/post-id',
      '/@alice@remote.example',
      '/search/results',
      '/settings/privacy',
      '/videos/next',
      '/unbounded/value',
    ].map(normalizeWebTelemetryRoute)).toEqual([
      '/',
      '/compose',
      '/explore',
      '/feed',
      '/feeds',
      '/oauth',
      '/post',
      '/profile',
      '/search',
      '/settings',
      '/videos',
      '/other',
    ]);
    expect(normalizeWebTelemetryRoute('')).toBe('/');
  });
});
