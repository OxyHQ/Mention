import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const { MemoryStore } = vi.hoisted(() => ({
  MemoryStore: class {
    private readonly hits = new Map<string, number>();

    init(): void {}

    async increment(key: string): Promise<{ totalHits: number; resetTime: undefined }> {
      const totalHits = (this.hits.get(key) ?? 0) + 1;
      this.hits.set(key, totalHits);
      return { totalHits, resetTime: undefined };
    }

    async decrement(key: string): Promise<void> {
      this.hits.set(key, Math.max(0, (this.hits.get(key) ?? 0) - 1));
    }

    async resetKey(key: string): Promise<void> {
      this.hits.delete(key);
    }
  },
}));

vi.mock('../../middleware/rateLimitStore', () => ({ RedisStore: MemoryStore }));

import { mentionCapabilityRateLimiter } from '../../capabilities/capabilityRateLimiter';

function buildApp(): express.Express {
  const app = express();
  app.use(mentionCapabilityRateLimiter);
  app.get('/resource', (_request, response) => response.json({ ok: true }));
  return app;
}

describe('Mention capability authorization rate limiting', () => {
  it('bounds capability tickets before authorization work', async () => {
    const app = buildApp();

    for (let requestIndex = 0; requestIndex < 120; requestIndex += 1) {
      const response = await request(app)
        .get('/resource')
        .set('Authorization', 'Capability signed-ticket');
      expect(response.status).toBe(200);
    }

    const limited = await request(app)
      .get('/resource')
      .set('Authorization', 'Capability signed-ticket');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('Too Many Requests');
  });

  it('does not spend the capability budget for ordinary callers', async () => {
    const response = await request(buildApp()).get('/resource');

    expect(response.status).toBe(200);
    expect(response.headers['ratelimit-limit']).toBeUndefined();
  });
});
