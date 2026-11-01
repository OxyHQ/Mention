import express from 'express';
import request from 'supertest';
import { OxyServer } from '@oxy.so/core/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ accept: vi.fn(), decline: vi.fn(), hydrate: vi.fn() }));
vi.mock('../../services/PostCollaborationService', () => ({
  postCollaborationService: {
    accept: effects.accept,
    decline: effects.decline,
    stopSharing: vi.fn(),
  },
  CollabStateError: class extends Error {},
}));
vi.mock('../../services/PostHydrationService', async (original) => ({
  ...(await original<typeof import('../../services/PostHydrationService')>()),
  postHydrationService: { hydratePosts: effects.hydrate },
}));
vi.mock('../../utils/oxyHelpers', async (original) => ({
  ...(await original<typeof import('../../utils/oxyHelpers')>()),
  createScopedOxyClient: () => ({}),
}));
import postsRouter from '../../routes/posts';

const oxy = new OxyServer({ baseURL: 'https://example.invalid' });
const validate = vi.spyOn(oxy.session, 'validate');
const app = express();
app.use(express.json());
app.use(oxy.middleware.auth());
app.use('/posts', postsRouter);
function token(userId: string) {
  const payload = Buffer.from(
    JSON.stringify({ userId, sessionId: `s-${userId}`, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  return `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.fixture`;
}
beforeEach(() => {
  vi.clearAllMocks();
  validate.mockResolvedValue({
    valid: true,
    user: { id: 'B' },
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    lastActivity: new Date().toISOString(),
    actor: { schemaVersion: 1, effectiveAccountId: 'B', actorAccountId: 'A', delegated: true },
  } as never);
  effects.accept.mockResolvedValue({ id: 'p' });
  effects.decline.mockResolvedValue({ id: 'p' });
  effects.hydrate.mockResolvedValue([{ id: 'p' }]);
});
afterAll(() => oxy.dispose());

it.each(['accept', 'decline'] as const)(
  'rejects A intent under B before collaborator %s',
  async (action) => {
    const res = await request(app)
      .post(`/posts/p/collaborators/_viewer/${action}`)
      .set('Authorization', `Bearer ${token('B')}`)
      .set('X-Mention-Expected-Viewer', 'A');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VIEWER_CHANGED');
    expect(validate).toHaveBeenCalled();
    expect(effects.accept).not.toHaveBeenCalled();
    expect(effects.decline).not.toHaveBeenCalled();
    expect(effects.hydrate).not.toHaveBeenCalled();
  },
);
it.each(['accept', 'decline'] as const)(
  'keeps authenticated effective account as the subject of %s',
  async (action) => {
    const res = await request(app)
      .post(`/posts/p/collaborators/_viewer/${action}`)
      .set('Authorization', `Bearer ${token('B')}`)
      .set('X-Mention-Expected-Viewer', 'B');
    expect(res.status).toBe(200);
    expect(effects[action]).toHaveBeenCalledWith('p', 'B');
  },
);
it('does not treat a viewer header as authentication', async () => {
  const res = await request(app)
    .post('/posts/p/collaborators/_viewer/accept')
    .set('X-Mention-Expected-Viewer', 'B');
  expect(res.status).toBe(401);
  expect(effects.accept).not.toHaveBeenCalled();
});
it.each(['accept', 'decline'] as const)('requires an intent for guarded %s', async (action) => {
  const res = await request(app)
    .post(`/posts/p/collaborators/_viewer/${action}`)
    .set('Authorization', `Bearer ${token('B')}`);
  expect(res.status).toBe(400);
  expect(effects.accept).not.toHaveBeenCalled();
  expect(effects.decline).not.toHaveBeenCalled();
});
it.each(['accept', 'decline'] as const)(
  'the old %s route cannot match a guarded request',
  async (action) => {
    const old = express();
    const legacy = vi.fn((_req: express.Request, res: express.Response) => res.sendStatus(200));
    old.post('/posts/:id/collaborators/accept', legacy);
    old.post('/posts/:id/collaborators/decline', legacy);
    const res = await request(old)
      .post(`/posts/p/collaborators/_viewer/${action}`)
      .set('X-Mention-Expected-Viewer', 'A');
    expect(res.status).toBe(404);
    expect(legacy).not.toHaveBeenCalled();
  },
);
