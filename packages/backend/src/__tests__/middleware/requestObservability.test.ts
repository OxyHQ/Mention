import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestObservability } from '../../middleware/requestObservability';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';

describe('requestObservability', () => {
  const app = express();
  app.use(requestObservability);
  app.get('/posts/:id', (_req, res) => res.status(200).json({ ok: true }));

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
    expect(metrics.getCounter('http_requests_total', {
      method: 'GET',
      route: '/posts/:id',
      status: '2xx',
    })).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      'HTTP request completed',
      expect.objectContaining({ route: '/posts/:id', requestId: 'request-safe-123' }),
    );
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(concreteId);
  });

  it('collapses unmatched paths instead of labeling attacker-controlled URLs', async () => {
    await request(app).get('/private-user-alice').expect(404);

    expect(metrics.getCounter('http_requests_total', {
      method: 'GET',
      route: '/unmatched',
      status: '4xx',
    })).toBe(1);
  });
});
