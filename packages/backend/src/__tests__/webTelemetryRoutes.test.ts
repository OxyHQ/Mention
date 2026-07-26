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

  it('normalizes dynamic application paths to a finite route vocabulary', () => {
    expect(normalizeWebTelemetryRoute('/feeds/abc')).toBe('/feeds');
    expect(normalizeWebTelemetryRoute('/@alice@remote.example')).toBe('/profile');
    expect(normalizeWebTelemetryRoute('/unbounded/value')).toBe('/other');
  });
});
