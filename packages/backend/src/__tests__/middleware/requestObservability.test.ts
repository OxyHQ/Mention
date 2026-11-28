import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { namedRoutePattern, requestObservability } from '../../middleware/requestObservability';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';

describe('requestObservability', () => {
  const app = express();
  app.use(requestObservability);
  app.get('/posts/:id', (_req, res) => res.status(200).json({ ok: true }));
  app.get(namedRoutePattern(/^\/p\/([^/]+)$/, '/p/:id'), (_req, res) => res.status(200).end());
  app.get('/health/ready', (req, res) => res.status(req.query.down ? 503 : 200).end());

  beforeEach(() => {
    metrics.reset();
    vi.clearAllMocks();
  });

  it('uses a route template and never records the concrete identifier', async () => {
    const concreteId = '65fdc8c8c8c8c8c8c8c8c8c8';
    const response = await request(app)
      .get(`/posts/${concreteId}`)
      .set('x-request-id', 'request-safe-123')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('request-safe-123');
    expect(
      metrics.getSeries('http_request_duration_ms').find(
        ({ labels }) =>
          JSON.stringify(labels) ===
          JSON.stringify({
            method: 'GET',
            route: '/posts/:id',
            status: '2xx',
          }),
      )?.count,
    ).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      'HTTP request completed',
      expect.objectContaining({ route: '/posts/:id', requestId: 'request-safe-123' }),
    );
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(concreteId);
  });

  it('collapses unmatched paths instead of labeling attacker-controlled URLs', async () => {
    await request(app).get('/private-user-alice').expect(404);

    expect(
      metrics.getSeries('http_request_duration_ms').find(
        ({ labels }) =>
          JSON.stringify(labels) ===
          JSON.stringify({
            method: 'GET',
            route: '/unmatched',
            status: '4xx',
          }),
      )?.count,
    ).toBe(1);
  });

  it('reports a RegExp route under its name, not as unmatched', async () => {
    await request(app).get('/p/65fdc8c8c8c8c8c8c8c8c8c8').expect(200);

    expect(
      metrics
        .getSeries('http_request_duration_ms')
        .find(({ labels }) => labels.route === '/p/:id' && labels.status === '2xx')?.count,
    ).toBe(1);
  });

  it('measures the readiness probe but logs it only when it fails', async () => {
    await request(app).get('/health/ready').expect(200);
    expect(logger.info).not.toHaveBeenCalled();
    expect(
      metrics
        .getSeries('http_request_duration_ms')
        .find(({ labels }) => labels.route === '/health/ready')?.count,
    ).toBe(1);

    await request(app).get('/health/ready?down=1').expect(503);
    expect(logger.info).toHaveBeenCalledWith(
      'HTTP request completed',
      expect.objectContaining({ route: '/health/ready', statusCode: 503 }),
    );
  });
});
