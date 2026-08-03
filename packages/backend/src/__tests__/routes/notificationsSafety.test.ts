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
  loadFollowedAuthorIds: vi.fn(),
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
  default: { deleteOne: vi.fn(), findOneAndUpdate: vi.fn() },
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
// sensitive-content and muted-word gates.
vi.mock('../../services/notificationInbox', () => ({
  resolveNotificationInboxIds: async (viewerId: string) => [viewerId],
}));

vi.mock('../../utils/mediaResolver', () => ({
  resolveAvatarUrl: (value?: string) => value,
}));

vi.mock('../../utils/push', () => ({ sendPushToUser: vi.fn() }));

vi.mock('../../services/safety/viewerSafety', () => ({
  loadShowSensitiveContent: mocks.loadShowSensitiveContent,
  loadMuteWords: mocks.loadMuteWords,
}));

vi.mock('../../services/viewerFollowGraph', () => ({
  loadFollowedAuthorIds: mocks.loadFollowedAuthorIds,
}));

import notificationsRouter from '../../routes/notifications';

const ENTITY_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
const NOTIFICATION_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439012');
const SENSITIVE_TEXT = 'graphic description nobody asked to read';
const MUTED_TEXT = 'massive spoilers for the finale';

type NotificationType = 'like' | 'reply' | 'mention' | 'post';

function mockNotificationPage(type: NotificationType) {
  const row = {
    _id: NOTIFICATION_ID,
    recipientId: 'viewer-1',
    actorId: 'actor-1',
    type,
    entityType: type === 'reply' ? 'reply' : 'post',
    entityId: ENTITY_ID,
    read: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const lean = vi.fn().mockResolvedValue([row]);
  const limit = vi.fn().mockReturnValue({ lean });
  const sort = vi.fn().mockReturnValue({ limit });
  mocks.notificationFind.mockReturnValue({ sort });
  mocks.notificationCountDocuments.mockResolvedValue(1);
}

/** The RAW referenced post row — where every sensitivity signal actually lives. */
function mockRawPost(fields: Record<string, unknown>) {
  const lean = vi.fn().mockResolvedValue([{ _id: ENTITY_ID, oxyUserId: 'actor-1', ...fields }]);
  mocks.postFind.mockReturnValue({ lean });
}

function mockHydrated(text: string, overrides: Record<string, unknown> = {}) {
  mocks.hydratePosts.mockResolvedValue([{
    id: String(ENTITY_ID),
    content: { text },
    metadata: {},
    user: { id: 'actor-1' },
    viewerState: { isOwner: false, isCollaborator: false },
    ...overrides,
  }]);
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
  mocks.loadFollowedAuthorIds.mockResolvedValue(new Set<string>());
  mockNotificationPage('reply');
  mockRawPost({});
  mockHydrated('an ordinary reply');
});

describe('GET /notifications sensitive-content gating', () => {
  it('withholds the preview text of a sensitive reply from a viewer who has not opted in', async () => {
    mockRawPost({ metadata: { isSensitive: true } });
    mockHydrated(SENSITIVE_TEXT);

    const res = await request(makeApp()).get('/').expect(200);

    // The notification itself survives — the viewer still learns someone replied.
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].type).toBe('reply');
    expect(res.body.notifications[0].preview).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(SENSITIVE_TEXT);
  });

  it('withholds the preview of a post carrying a federated content warning', async () => {
    mockRawPost({ federation: { spoilerText: 'CW: injury' } });
    mockHydrated(SENSITIVE_TEXT);

    const res = await request(makeApp()).get('/').expect(200);

    expect(res.body.notifications[0].preview).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(SENSITIVE_TEXT);
  });

  it('withholds the preview of a post tagged with an NSFW hashtag', async () => {
    mockRawPost({ hashtags: ['nsfw'] });
    mockHydrated(SENSITIVE_TEXT);

    const res = await request(makeApp()).get('/').expect(200);

    expect(res.body.notifications[0].preview).toBeUndefined();
  });

  it('shows the preview once the viewer has opted into sensitive content', async () => {
    mocks.loadShowSensitiveContent.mockResolvedValue(true);
    mockRawPost({ metadata: { isSensitive: true } });
    mockHydrated(SENSITIVE_TEXT);

    const res = await request(makeApp()).get('/').expect(200);

    expect(res.body.notifications[0].preview).toBe(SENSITIVE_TEXT);
  });

  it('still previews the viewer’s OWN sensitive post, which is no surprise to its author', async () => {
    mockNotificationPage('like');
    mockRawPost({ metadata: { isSensitive: true } });
    mockHydrated(SENSITIVE_TEXT, { viewerState: { isOwner: true, isCollaborator: false } });

    const res = await request(makeApp()).get('/').expect(200);

    expect(res.body.notifications[0].preview).toBe(SENSITIVE_TEXT);
  });

  it('drops the embedded post of a sensitive `post` notification, not just the preview', async () => {
    mockNotificationPage('post');
    mockRawPost({ metadata: { isSensitive: true } });
    mockHydrated(SENSITIVE_TEXT);

    const res = await request(makeApp()).get('/').expect(200);

    expect(res.body.notifications[0].post).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(SENSITIVE_TEXT);
  });
});

describe('GET /notifications muted words', () => {
  it('removes a reply notification whose post contains a term the viewer muted', async () => {
    mocks.loadMuteWords.mockResolvedValue([
      { value: 'spoilers', targets: ['content', 'tag'], actorTarget: 'all' },
    ]);
    mockHydrated(MUTED_TEXT);

    const res = await request(makeApp()).get('/').expect(200);

    expect(res.body.notifications).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('spoilers');
  });

  it('removes a mention notification whose post carries a muted hashtag', async () => {
    mockNotificationPage('mention');
    mocks.loadMuteWords.mockResolvedValue([
      { value: 'politics', targets: ['tag'], actorTarget: 'all' },
    ]);
    mockHydrated('election night', { metadata: { hashtags: ['Politics'] } });

    const res = await request(makeApp()).get('/').expect(200);

    expect(res.body.notifications).toEqual([]);
  });

  it('keeps a like on the viewer’s OWN post even when it matches their muted word', async () => {
    mockNotificationPage('like');
    mocks.loadMuteWords.mockResolvedValue([
      { value: 'spoilers', targets: ['content'], actorTarget: 'all' },
    ]);
    mockHydrated(MUTED_TEXT, { viewerState: { isOwner: true, isCollaborator: false } });

    const res = await request(makeApp()).get('/').expect(200);

    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].type).toBe('like');
  });

  it('keeps a reply from a followed author when the muted word excludes follows', async () => {
    mocks.loadMuteWords.mockResolvedValue([
      { value: 'spoilers', targets: ['content'], actorTarget: 'exclude-following' },
    ]);
    mocks.loadFollowedAuthorIds.mockResolvedValue(new Set(['actor-1']));
    mockHydrated(MUTED_TEXT);

    const res = await request(makeApp()).get('/').expect(200);

    expect(mocks.loadFollowedAuthorIds).toHaveBeenCalledWith('viewer-1', { scope: 'viewer-1' });
    expect(res.body.notifications).toHaveLength(1);
  });

  it('does not pay for the follow-graph lookup when no muted word needs it', async () => {
    mocks.loadMuteWords.mockResolvedValue([
      { value: 'spoilers', targets: ['content'], actorTarget: 'all' },
    ]);
    mockHydrated('an ordinary reply');

    await request(makeApp()).get('/').expect(200);

    expect(mocks.loadFollowedAuthorIds).not.toHaveBeenCalled();
  });
});
