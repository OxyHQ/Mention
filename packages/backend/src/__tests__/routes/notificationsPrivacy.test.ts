/**
 * `GET /notifications` — post privacy, against real notification rows.
 *
 * A notification carries OTHER people's post text, so the preview and the
 * embedded post may only ever be built from the viewer-aware hydration/ACL path.
 * Never from the raw row: that would reveal content from a newly blocked author,
 * a private profile, a followers-only post or a draft that hydration correctly
 * removes for this viewer.
 *
 * The notifications are REAL Postgres rows; `models/Post` and
 * `PostHydrationService` are stubbed because `posts` belongs to another batch and
 * the ACL under test is hydration's answer, not the post's content.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  postFind: vi.fn(),
  hydratePosts: vi.fn(),
  getUsersByIds: vi.fn(),
  createScopedOxyClient: vi.fn(),
  loadFollowedAuthorIds: vi.fn(),
}));

vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../models/Post', () => ({ default: { find: mocks.postFind } }));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: mocks.hydratePosts },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: mocks.createScopedOxyClient,
  getServiceOxyClient: () => ({ getUsersByIds: mocks.getUsersByIds }),
}));

vi.mock('../../utils/mediaResolver', () => ({
  resolveAvatarUrl: (value?: string) => value,
}));

vi.mock('../../utils/push', () => ({
  sendPushToUser: vi.fn(),
  formatPushForNotification: vi.fn(),
}));

vi.mock('../../services/viewerFollowGraph', () => ({
  loadFollowedAuthorIds: mocks.loadFollowedAuthorIds,
}));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { uuidv7 } from '../../db/schema/columns';
import { notifications } from '../../db/schema/discovery';
import notificationsRouter from '../../routes/notifications';

let db: Database;
const createdRecipientIds: string[] = [];

const ENTITY_ID = '507f1f77bcf86cd799439011';
const RAW_PRIVATE_TEXT = 'raw private text that must never leave the posts store';

function viewerId(): string {
  const id = `oxy-privacy-viewer-${randomUUID()}`;
  createdRecipientIds.push(id);
  return id;
}

async function seedNotification(recipient: string, type: 'like' | 'post' = 'like') {
  await db.insert(notifications).values({
    // A fresh id per row: suites share one database and run in parallel, so a
    // fixed primary key collides across files rather than across tests.
    id: uuidv7(),
    recipientId: recipient,
    actorId: 'actor-1',
    type,
    entityType: 'post',
    entityId: ENTITY_ID,
    read: false,
  });
}

/** The RAW referenced post row — what hydration is asked about, never rendered. */
function mockRawPost() {
  mocks.postFind.mockReturnValue({
    lean: vi.fn().mockResolvedValue([{
      _id: ENTITY_ID,
      oxyUserId: 'actor-1',
      content: { variants: [{ type: 'author', text: RAW_PRIVATE_TEXT }] },
      visibility: 'private',
      status: 'published',
    }]),
  });
}

function makeApp(viewer: string) {
  const app = express();
  app.use((req, _res, next) => {
    (req as typeof req & { user: { id: string } }).user = { id: viewer };
    next();
  });
  app.use('/', notificationsRouter);
  return app;
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUsersByIds.mockResolvedValue([]);
  mocks.createScopedOxyClient.mockReturnValue({ scope: 'viewer' });
  mocks.loadFollowedAuthorIds.mockResolvedValue(new Set<string>());
  mockRawPost();
});

afterEach(async () => {
  if (createdRecipientIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.recipientId, createdRecipientIds));
    createdRecipientIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /notifications post privacy', () => {
  it('never derives a preview from a raw post excluded by viewer-aware hydration', async () => {
    const viewer = viewerId();
    await seedNotification(viewer);
    mocks.hydratePosts.mockResolvedValue([]);

    const response = await request(makeApp(viewer)).get('/').expect(200);

    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0]).not.toHaveProperty('preview');
    expect(response.body.notifications[0]).not.toHaveProperty('post');
    expect(JSON.stringify(response.body)).not.toContain(RAW_PRIVATE_TEXT);
    expect(mocks.hydratePosts).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ oxyUserId: 'actor-1' })]),
      expect.objectContaining({
        viewerId: viewer,
        oxyClient: { scope: 'viewer' },
      }),
    );
  });

  it('fails the whole page closed when viewer-aware hydration cannot resolve privacy', async () => {
    const viewer = viewerId();
    await seedNotification(viewer);
    mocks.hydratePosts.mockRejectedValue(new Error('privacy authority unavailable'));

    const response = await request(makeApp(viewer)).get('/').expect(500);

    expect(response.body.notifications).toEqual([]);
    expect(response.body.hasMore).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain(RAW_PRIVATE_TEXT);
  });

  it('builds a preview only from the already-authorized hydrated DTO', async () => {
    const viewer = viewerId();
    await seedNotification(viewer);
    mocks.hydratePosts.mockResolvedValue([{
      id: ENTITY_ID,
      content: { text: 'authorized localized preview' },
    }]);

    const response = await request(makeApp(viewer)).get('/').expect(200);

    expect(response.body.notifications[0].preview).toBe('authorized localized preview');
    expect(JSON.stringify(response.body)).not.toContain(RAW_PRIVATE_TEXT);
  });

  it('embeds the hydrated post only for a `post` notification', async () => {
    // The full embed stays gated to `type:'post'`; a like resolves the cheap
    // text preview and nothing more.
    const viewer = viewerId();
    await seedNotification(viewer, 'post');
    mocks.hydratePosts.mockResolvedValue([{
      id: ENTITY_ID,
      content: { text: 'authorized localized preview' },
    }]);

    const response = await request(makeApp(viewer)).get('/').expect(200);
    expect(response.body.notifications[0].post).toMatchObject({ id: ENTITY_ID });
  });
});

describe('GET /notifications degraded actor identity', () => {
  it('uses a neutral actor when the Oxy bulk lookup misses', async () => {
    const viewer = viewerId();
    await seedNotification(viewer);
    mocks.getUsersByIds.mockResolvedValue([]);
    mocks.hydratePosts.mockResolvedValue([]);

    const response = await request(makeApp(viewer)).get('/').expect(200);
    const actor = response.body.notifications[0].actorId_populated;

    expect(actor).toMatchObject({
      _id: 'actor-1',
      username: '',
      name: { displayName: 'Unknown user' },
    });
  });

  it('uses a neutral actor when Oxy is unavailable', async () => {
    const viewer = viewerId();
    await seedNotification(viewer);
    mocks.getUsersByIds.mockRejectedValue(new Error('oxy unavailable'));
    mocks.hydratePosts.mockResolvedValue([]);

    const response = await request(makeApp(viewer)).get('/').expect(200);
    const actor = response.body.notifications[0].actorId_populated;

    expect(actor).toMatchObject({
      _id: 'actor-1',
      username: '',
      name: { displayName: 'Unknown user' },
    });
  });
});
