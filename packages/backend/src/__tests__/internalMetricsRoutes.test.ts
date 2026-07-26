import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInternalMetricsRouter } from '../routes/internalMetrics.routes';
import { metrics } from '../utils/metrics';

describe('internal metrics route', () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(createInternalMetricsRouter({
    enabled: true,
    token: 'test-metrics-secret',
    allowedIps: [],
  }));

  beforeEach(() => {
    metrics.reset();
  });

  it('hides the endpoint without a valid bearer token', async () => {
    await request(app).get('/internal/metrics').expect(404);
    await request(app)
      .get('/internal/metrics')
      .set('authorization', 'Bearer wrong')
      .expect(404);
  });

  it('serves valid Prometheus output to an authenticated private caller', async () => {
    metrics.incrementCounter('feed_impression_total', 1, {
      descriptor: 'for_you',
      origin: 'local',
    });

    const response = await request(app)
      .get('/internal/metrics')
      .set('authorization', 'Bearer test-metrics-secret')
      .expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('feed_impression_total');
    expect(response.text).not.toContain('user_id');
  });

  it('rejects a public source even when the token is valid', async () => {
    await request(app)
      .get('/internal/metrics')
      .set('x-forwarded-for', '203.0.113.8')
      .set('authorization', 'Bearer test-metrics-secret')
      .expect(404);
  });
});
