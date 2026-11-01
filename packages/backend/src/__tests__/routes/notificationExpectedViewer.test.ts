import express from 'express';
import request from 'supertest';
import { OxyServer } from '@oxy.so/core/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({
  read: vi.fn(),
  readAll: vi.fn(),
  remove: vi.fn(),
  archive: vi.fn(),
  inbox: vi.fn(),
}));
vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../services/notificationReadState', () => ({
  SYSTEM_ACTOR: 'system',
  enrichNotificationActor: vi.fn(async (row: unknown) => row),
  markNotificationRead: effects.read,
  markAllNotificationsRead: effects.readAll,
}));
vi.mock('../../services/notificationInbox', () => ({ resolveNotificationInboxIds: effects.inbox }));
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(),
  createUserScopedOxyServices: vi.fn(() => ({})),
  getServiceOxyClient: vi.fn(),
}));
vi.mock('../../db/postgres', () => ({
  getDb: () => ({
    delete: () => ({ where: () => ({ returning: effects.remove }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: effects.archive }) }) }),
  }),
}));
import notificationsRouter from '../../routes/notifications';

const oxy = new OxyServer({ baseURL: 'https://example.invalid' });
const validate = vi.spyOn(oxy.session, 'validate');
const emit = vi.fn();
const app = express();
app.use(express.json());
app.set('notificationsNamespace', { to: () => ({ emit }) });
app.use(oxy.middleware.auth());
app.use('/notifications', notificationsRouter);

function token(userId: string) {
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      sessionId: `session-${userId}`,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  return `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.fixture`;
}
function validateUser(userId: string, actorId = userId) {
  validate.mockResolvedValue({
    valid: true,
    user: { id: userId },
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    lastActivity: new Date().toISOString(),
    actor: {
      schemaVersion: 1,
      effectiveAccountId: userId,
      actorAccountId: actorId,
      delegated: actorId !== userId,
    },
  } as never);
}
beforeEach(() => {
  vi.clearAllMocks();
  validateUser('B');
  effects.inbox.mockImplementation(async (id: string) => [id]);
  effects.read.mockResolvedValue({ id: 'n' });
  effects.readAll.mockResolvedValue(undefined);
  effects.remove.mockResolvedValue([{ id: 'n' }]);
  effects.archive.mockResolvedValue([{ id: 'n' }]);
});
afterAll(() => oxy.dispose());

describe('notification viewer precondition after real Oxy authentication', () => {
  const paths = [
    { method: 'patch' as const, path: '/_viewer/read-all' },
    { method: 'patch' as const, path: '/_viewer/n/read' },
    { method: 'patch' as const, path: '/_viewer/n/archive' },
    { method: 'delete' as const, path: '/_viewer/n' },
  ];
  it.each(paths)(
    'refuses A intent authenticated as B at $path before any side effect',
    async ({ method, path }) => {
      const res = await request(app)
        [method](`/notifications${path}`)
        .set('Authorization', `Bearer ${token('B')}`)
        .set('X-Mention-Expected-Viewer', 'A');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VIEWER_CHANGED');
      expect(validate).toHaveBeenCalled();
      expect(effects.inbox).not.toHaveBeenCalled();
      expect(effects.readAll).not.toHaveBeenCalled();
      expect(effects.read).not.toHaveBeenCalled();
      expect(effects.remove).not.toHaveBeenCalled();
      expect(effects.archive).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    },
  );
  it.each(paths)('requires the expected viewer at $path', async ({ method, path }) => {
    const res = await request(app)
      [method](`/notifications${path}`)
      .set('Authorization', `Bearer ${token('B')}`);
    expect(res.status).toBe(400);
    expect(effects.inbox).not.toHaveBeenCalled();
  });
  it.each(paths)('accepts matching B intent at $path', async ({ method, path }) => {
    const res = await request(app)
      [method](`/notifications${path}`)
      .set('Authorization', `Bearer ${token('B')}`)
      .set('X-Mention-Expected-Viewer', 'B');
    expect(res.status).toBe(200);
    expect(effects.inbox).toHaveBeenCalledWith('B', expect.anything());
  });
  it('compares the authenticated effective subject for a delegated actor', async () => {
    validateUser('B', 'A');
    const res = await request(app)
      .patch('/notifications/_viewer/read-all')
      .set('Authorization', `Bearer ${token('B')}`)
      .set('X-Mention-Expected-Viewer', 'B');
    expect(res.status).toBe(200);
    expect(effects.readAll).toHaveBeenCalledWith(['B']);
  });
  it('preserves legacy calls without the new header', async () => {
    const res = await request(app)
      .patch('/notifications/read-all')
      .set('Authorization', `Bearer ${token('B')}`);
    expect(res.status).toBe(200);
    expect(effects.readAll).toHaveBeenCalledWith(['B']);
  });
  it('does not authenticate a forged precondition', async () => {
    const res = await request(app)
      .patch('/notifications/_viewer/read-all')
      .set('X-Mention-Expected-Viewer', 'B');
    expect(res.status).toBe(401);
    expect(effects.inbox).not.toHaveBeenCalled();
  });
  it('rejects multiple expected-viewer values before a mutation', async () => {
    const res = await request(app)
      .patch('/notifications/_viewer/read-all')
      .set('Authorization', `Bearer ${token('B')}`)
      .set('X-Mention-Expected-Viewer', ['A', 'B']);
    expect(res.status).toBe(400);
    expect(effects.inbox).not.toHaveBeenCalled();
    expect(effects.readAll).not.toHaveBeenCalled();
  });
  it('does not fall through to legacy handlers when a backend lacks the new routes', async () => {
    const old = express();
    const legacyWrite = vi.fn((_req: express.Request, res: express.Response) =>
      res.sendStatus(200),
    );
    old.patch('/notifications/:id/read', legacyWrite);
    old.patch('/notifications/read-all', legacyWrite);
    old.patch('/notifications/:id/archive', legacyWrite);
    old.delete('/notifications/:id', legacyWrite);
    for (const { method, path } of paths) {
      const res = await request(old)
        [method](`/notifications${path}`)
        .set('X-Mention-Expected-Viewer', 'A');
      expect(res.status).toBe(404);
    }
    expect(legacyWrite).not.toHaveBeenCalled();
  });
});
