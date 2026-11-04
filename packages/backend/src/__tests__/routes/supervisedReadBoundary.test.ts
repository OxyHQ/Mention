import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { OxyServer } from '@oxy.so/core/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOptionalAuth } from '../../middleware/optionalAuth';
import { supervisedActionForRequest } from '../../middleware/supervisedAction';

afterEach(() => vi.restoreAllMocks());

describe('reviewed optional reads', () => {
  it('never falls through to an anonymous cached feed when session verification fails', async () => {
    const oxy = new OxyServer({ baseURL: 'http://127.0.0.1:9' });
    vi.spyOn(oxy.middleware, 'auth').mockImplementation(
      () => (_req, _res, next) => next(new Error('Oxy unavailable')),
    );
    const anonymousFeed = vi.fn((_req, res: express.Response) =>
      res.json({ items: ['public cache body'] }),
    );
    const app = express();
    app.use('/api', createOptionalAuth(oxy));
    app.get('/api/feed/mtn', anonymousFeed);
    const onError: ErrorRequestHandler = (_error, _req, res, _next) => {
      res.status(503).json({ code: 'AUTHORITY_UNAVAILABLE' });
    };
    app.use(onError);
    const result = await request(app)
      .get('/api/feed/mtn')
      .set('Authorization', 'Bearer original-supervised-session');
    expect(result.status).toBe(503);
    expect(result.text).not.toContain('public cache body');
    expect(anonymousFeed).not.toHaveBeenCalled();
    // The accepted service audience is the server's own (`runtime/oxyClient`),
    // not repeated at the mount.
    expect(oxy.middleware.auth).toHaveBeenCalledWith({ supervisedAction: 'content' });
  });

  it('builds each auth mount once, not once per request', async () => {
    const oxy = new OxyServer({ baseURL: 'http://127.0.0.1:9' });
    const auth = vi
      .spyOn(oxy.middleware, 'auth')
      .mockImplementation(() => (_req, _res, next) => next());
    const app = express();
    app.use('/api', createOptionalAuth(oxy));
    app.get('/api/feed/mtn', (_req, res) => res.json({ items: [] }));
    app.get('/api/search', (_req, res) => res.json({ items: [] }));
    for (const path of ['/api/feed/mtn', '/api/feed/mtn', '/api/search', '/api/search']) {
      await request(app).get(path).set('Authorization', 'Bearer session');
    }
    expect(auth).toHaveBeenCalledTimes(2);
    expect(auth).toHaveBeenCalledWith({ supervisedAction: 'content' });
    expect(auth).toHaveBeenCalledWith({});
  });

  it('preserves genuinely anonymous browsing without turning it into a supervised session', async () => {
    const oxy = new OxyServer({ baseURL: 'http://127.0.0.1:9' });
    const auth = vi.spyOn(oxy.middleware, 'auth');
    const app = express();
    app.use('/api', createOptionalAuth(oxy));
    app.get('/api/feed/mtn', (_req, res) => res.json({ items: [] }));
    expect((await request(app).get('/api/feed/mtn')).status).toBe(200);
    expect(auth).not.toHaveBeenCalled();
  });

  it.each([
    '/search',
    '/lists',
    '/community-notes/post/id',
    '/feeds/id',
    '/posts/id/corrections',
    '/posts/id/translate',
    '/posts/link-previews',
    '/posts/translate-draft',
    '/profile/other',
  ])('does not grant a content category to the unreviewed %s surface', (path) => {
    expect(supervisedActionForRequest({ baseUrl: '/api', path, method: 'GET' })).toBeUndefined();
  });
});
