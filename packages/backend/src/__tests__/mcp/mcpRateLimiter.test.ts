import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const { MemoryStore } = vi.hoisted(() => ({
  MemoryStore: class {
    init(): void {}
    async increment(): Promise<{ totalHits: number; resetTime: undefined }> {
      return { totalHits: 1, resetTime: undefined };
    }
    async decrement(): Promise<void> {}
    async resetKey(): Promise<void> {}
  },
}));

vi.mock('../../middleware/rateLimitStore', () => ({ RedisStore: MemoryStore }));

import { config } from '../../config';
import { routeRateLimitByBearer } from '../../mcp/middleware/mcpRateLimiter';

describe('routeRateLimitByBearer', () => {
  it('keeps an MCP bearer away from the Oxy session limiter and budgets it per IP', async () => {
    const sessionRateLimiter = vi.fn((_req, _res, next: express.NextFunction) => next());
    const app = express();
    app.use(routeRateLimitByBearer(sessionRateLimiter));
    app.get('/resource', (_req, res) => res.json({ ok: true }));
    const mcpToken = jwt.sign({ aud: config.deploymentMcp.audience }, 'routing-only', {
      algorithm: 'HS256',
    });

    const mcp = await request(app).get('/resource').set('Authorization', `Bearer ${mcpToken}`);
    expect(mcp.status).toBe(200);
    expect(mcp.headers['ratelimit-limit']).toBe('600');
    expect(sessionRateLimiter).not.toHaveBeenCalled();

    await request(app).get('/resource').set('Authorization', 'Bearer session-token');
    expect(sessionRateLimiter).toHaveBeenCalledTimes(1);
  });
});
