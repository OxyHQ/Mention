import express, { type Express } from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeAll } from 'vitest';

/**
 * Phase C4 — the bridge DISABLED gate. With ATPROTO_BRIDGE_ENABLED unset, EVERY
 * bridge route 404s (the be-discovered surface is dark by default). This file
 * deliberately leaves the env flag unset (vitest isolates modules per file, so
 * the routes module reads the default-off gate at import).
 */

// Ensure the flag is OFF for this file even if the ambient env had it set.
delete process.env.ATPROTO_BRIDGE_ENABLED;

vi.mock('../../../../middleware/rateLimitStore', () => ({
  RedisStore: class {
    init(): void {}
    async increment(): Promise<{ totalHits: number; resetTime: undefined }> {
      return { totalHits: 1, resetTime: undefined };
    }
    async decrement(): Promise<void> {}
    async resetKey(): Promise<void> {}
    async get(): Promise<undefined> {
      return undefined;
    }
  },
}));

let app: Express;

beforeAll(async () => {
  const mod = await import('../../../../connectors/atproto/bridge/routes');
  app = express();
  app.use('/xrpc', mod.default);
  app.use('/ap-bridge', mod.bridgeMetaRouter);
});

describe('bridge disabled gate', () => {
  it('404s listRecords when the bridge is off', async () => {
    const res = await request(app)
      .get('/xrpc/com.atproto.repo.listRecords')
      .query({ repo: 'did:web:oxy.so:u:x', collection: 'app.bsky.feed.post' });
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/disabled/);
  });

  it('404s the DID-document view when the bridge is off', async () => {
    const res = await request(app).get('/ap-bridge/did/alice');
    expect(res.status).toBe(404);
  });
});
