/**
 * `POST /privacy/refresh`.
 *
 * The endpoint exists so a client that just wrote a block to Oxy does not have
 * to wait out Mention's privacy freshness window before the feed acts on it. Two
 * properties matter and both are asserted here: it drops the AUTHENTICATED
 * caller's entry (never an id taken from the request), and it refuses a caller
 * with no session.
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invalidateViewerRelations = vi.fn(async () => {});

vi.mock('../../utils/privacyHelpers', () => ({
  invalidateViewerRelations: (viewerId: string) => invalidateViewerRelations(viewerId),
}));

import privacyRouter from '../../routes/privacy.routes';

function makeApp(viewer: string | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (viewer) (req as typeof req & { user: { id: string } }).user = { id: viewer };
    next();
  });
  app.use('/privacy', privacyRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /privacy/refresh', () => {
  it('drops the authenticated caller’s cached relations', async () => {
    const res = await request(makeApp('viewer-1'))
      .post('/privacy/refresh')
      .send({ userId: 'someone-else' });

    expect(res.status).toBe(204);
    expect(invalidateViewerRelations).toHaveBeenCalledWith('viewer-1');
  });

  it('refuses a caller with no session and evicts nothing', async () => {
    const res = await request(makeApp(undefined)).post('/privacy/refresh');

    expect(res.status).toBe(401);
    expect(invalidateViewerRelations).not.toHaveBeenCalled();
  });
});
