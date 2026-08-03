import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  notificationFind: vi.fn(),
  notificationCountDocuments: vi.fn(),
  postFind: vi.fn(),
  hydratePosts: vi.fn(),
  getUsersByIds: vi.fn(),
  createScopedOxyClient: vi.fn(),
  loadShowSensitiveContent: vi.fn(),
  loadMuteWords: vi.fn(),
}));

// The viewer's safety preferences are read from Mongo; this suite has no database,
// and the gates themselves are covered by `notificationsSafety.test.ts`.
vi.mock('../../services/safety/viewerSafety', () => ({
  loadShowSensitiveContent: mocks.loadShowSensitiveContent,
  loadMuteWords: mocks.loadMuteWords,
}));

vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../models/Notification', () => ({
  default: {
    find: mocks.notificationFind,
    countDocuments: mocks.notificationCountDocuments,
  },
}));

vi.mock('../../models/Post', () => ({
  default: { find: mocks.postFind },
}));

vi.mock('../../models/PushToken', () => ({
  default: {
    deleteOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: mocks.hydratePosts },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: mocks.createScopedOxyClient,
  createUserScopedOxyServices: () => undefined,
  getServiceOxyClient: () => ({ getUsersByIds: mocks.getUsersByIds }),
}));

// Which recipient ids the viewer's inbox covers is `notificationInboxScope.test.ts`'s
// subject; here it is held at "just the viewer" so these cases stay about the
// privacy of what a notification may reveal.
vi.mock('../../services/notificationInbox', () => ({
  resolveNotificationInboxIds: async (viewerId: string) => [viewerId],
}));

vi.mock('../../utils/mediaResolver', () => ({
  resolveAvatarUrl: (value?: string) => value,
}));

vi.mock('../../utils/push', () => ({
  sendPushToUser: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import notificationsRouter from '../../routes/notifications';

const ENTITY_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
const NOTIFICATION_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439012');
const RAW_PRIVATE_TEXT = 'raw private text that must never leave Mongo';

function notificationRow(type: 'like' | 'post' = 'like') {
  return {
    _id: NOTIFICATION_ID,
    recipientId: 'viewer-1',
    actorId: 'actor-1',
    type,
    entityType: 'post',
    entityId: ENTITY_ID,
    read: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function mockNotificationPage(row = notificationRow()) {
  const lean = vi.fn().mockResolvedValue([row]);
  const limit = vi.fn().mockReturnValue({ lean });
  const sort = vi.fn().mockReturnValue({ limit });
  mocks.notificationFind.mockReturnValue({ sort });
  mocks.notificationCountDocuments.mockResolvedValue(1);
}

function mockRawPost() {
  const lean = vi.fn().mockResolvedValue([{
    _id: ENTITY_ID,
    oxyUserId: 'actor-1',
    content: {
      variants: [{ type: 'author', text: RAW_PRIVATE_TEXT }],
    },
    visibility: 'private',
    status: 'published',
  }]);
  mocks.postFind.mockReturnValue({ lean });
}

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as typeof req & { user: { id: string } }).user = { id: 'viewer-1' };
    next();
  });
  app.use('/', notificationsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUsersByIds.mockResolvedValue([]);
  mocks.createScopedOxyClient.mockReturnValue({ scope: 'viewer-1' });
  mocks.loadShowSensitiveContent.mockResolvedValue(false);
  mocks.loadMuteWords.mockResolvedValue([]);
  mockNotificationPage();
  mockRawPost();
});

describe('GET /notifications post privacy', () => {
  it('never derives a preview from a raw post excluded by viewer-aware hydration', async () => {
    mocks.hydratePosts.mockResolvedValue([]);

    const response = await request(makeApp()).get('/').expect(200);

    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0]).not.toHaveProperty('preview');
    expect(response.body.notifications[0]).not.toHaveProperty('post');
    expect(JSON.stringify(response.body)).not.toContain(RAW_PRIVATE_TEXT);
    expect(mocks.hydratePosts).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ oxyUserId: 'actor-1' })]),
      expect.objectContaining({
        viewerId: 'viewer-1',
        oxyClient: { scope: 'viewer-1' },
      }),
    );
  });

  it('fails the whole page closed when viewer-aware hydration cannot resolve privacy', async () => {
    mocks.hydratePosts.mockRejectedValue(new Error('privacy authority unavailable'));

    const response = await request(makeApp()).get('/').expect(500);

    expect(response.body.notifications).toEqual([]);
    expect(response.body.hasMore).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain(RAW_PRIVATE_TEXT);
  });

  it('builds a preview only from the already-authorized hydrated DTO', async () => {
    mocks.hydratePosts.mockResolvedValue([{
      id: String(ENTITY_ID),
      content: { text: 'authorized localized preview' },
    }]);

    const response = await request(makeApp()).get('/').expect(200);

    expect(response.body.notifications[0].preview).toBe('authorized localized preview');
    expect(JSON.stringify(response.body)).not.toContain(RAW_PRIVATE_TEXT);
  });
});

describe('GET /notifications degraded actor identity', () => {
  it('uses a neutral actor when the Oxy bulk lookup misses', async () => {
    mocks.getUsersByIds.mockResolvedValue([]);
    mocks.hydratePosts.mockResolvedValue([]);

    const response = await request(makeApp()).get('/').expect(200);
    const actor = response.body.notifications[0].actorId_populated;

    expect(actor).toMatchObject({
      _id: 'actor-1',
      username: '',
      name: { displayName: 'Unknown user' },
    });
  });

  it('uses a neutral actor when Oxy is unavailable', async () => {
    mocks.getUsersByIds.mockRejectedValue(new Error('oxy unavailable'));
    mocks.hydratePosts.mockResolvedValue([]);

    const response = await request(makeApp()).get('/').expect(200);
    const actor = response.body.notifications[0].actorId_populated;

    expect(actor).toMatchObject({
      _id: 'actor-1',
      username: '',
      name: { displayName: 'Unknown user' },
    });
  });
});
