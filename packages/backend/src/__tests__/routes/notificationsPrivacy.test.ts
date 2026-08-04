/**
 * `GET /notifications` — post privacy, against real notification AND post rows.
 *
 * A notification carries OTHER people's post text, so the preview and the
 * embedded post may only ever be built from the viewer-aware hydration/ACL path.
 * Never from the raw row: that would reveal content from a newly blocked author,
 * a private profile, a followers-only post or a draft that hydration correctly
 * removes for this viewer.
 *
 * ## Why the referenced post is a real row now
 *
 * The suite this replaces mocked `models/Post`, which meant "the preview did not
 * leak the raw text" was checked against a literal the test had just handed the
 * route — it could not tell a working ACL from one that matched nothing, because
 * a mock always matches. The route reads `loadPostRecords` today, so each case
 * below writes a post the viewer genuinely may not see (private, followers-only,
 * a draft) and asserts the response never carries its body.
 *
 * Hydration itself runs for real; only Oxy (a foreign HTTP service) and the
 * Redis summary cache are stubbed.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { PostVisibility } from '@mention/shared-types';

const mocks = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  hydratePosts: vi.fn(),
}));

vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: () => ({ getUserFollowing: vi.fn(async () => []) }),
  // The route hands this to `resolveNotificationInboxIds`; a module factory
  // replaces the WHOLE module, so an export the route calls and this factory
  // omits is `undefined is not a function` on every request.
  createUserScopedOxyServices: () => undefined,
  getServiceOxyClient: () => ({
    getUsersByIds: mocks.getUsersByIds,
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));

// Which recipient ids the viewer's inbox covers is
// `notificationsChannelInbox.test.ts`'s subject; here it is held at "just the
// viewer" so these cases stay about the privacy of what a notification may
// reveal. Pinned rather than left real: the live resolver reads Redis and Oxy,
// neither of which decides anything this file asserts.
vi.mock('../../services/notificationInbox', () => ({
  resolveNotificationInboxIds: async (viewerId: string) => [viewerId],
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById: vi.fn(async () => null),
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  }),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
}));

vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async () => new Map()),
  mset: vi.fn(async () => undefined),
}));

vi.mock('../../utils/push', () => ({
  sendPushToUser: vi.fn(),
  formatPushForNotification: vi.fn(),
}));

/**
 * A SPY over the real hydration, not a stub.
 *
 * Every assertion below is about what the ROUTE served, which the real service
 * decides. The spy exists for the two cases a stub is genuinely the only way to
 * stage: observing the arguments the route hands hydration, and forcing the
 * privacy authority to fail.
 */
vi.mock('../../services/PostHydrationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/PostHydrationService')>();
  mocks.hydratePosts.mockImplementation(
    actual.postHydrationService.hydratePosts.bind(actual.postHydrationService),
  );
  return {
    ...actual,
    postHydrationService: {
      ...actual.postHydrationService,
      hydratePosts: mocks.hydratePosts,
    },
  };
});

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { uuidv7 } from '../../db/schema/columns';
import { notifications } from '../../db/schema/discovery';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import notificationsRouter from '../../routes/notifications';

const scope = postScope('notifications-privacy');
const ACTOR = scope.user('actor');

let db: Database;
const createdRecipientIds: string[] = [];

const RAW_PRIVATE_TEXT = 'raw private text that must never leave the posts store';

function viewerId(): string {
  const id = `oxy-privacy-viewer-${randomUUID()}`;
  createdRecipientIds.push(id);
  return id;
}

/** A real post authored by {@link ACTOR}, carrying whatever ACL a case needs. */
async function seedReferencedPost(
  text: string,
  overrides: Partial<PostRecordInput> = {},
): Promise<string> {
  const owner = (overrides.oxyUserId ?? ACTOR) as string;
  const record = await seedPost(scope, {
    oxyUserId: owner,
    authorship: [{ oxyUserId: owner, role: 'owner', status: 'accepted' }],
    content: { variants: [{ source: 'author', text, tag: 'en' }] },
    ...overrides,
  });
  return record.id;
}

async function seedNotification(
  recipient: string,
  entityId: string,
  type: 'like' | 'post' = 'like',
) {
  await db.insert(notifications).values({
    // A fresh id per row: suites share one database and run in parallel, so a
    // fixed primary key collides across files rather than across tests.
    id: uuidv7(),
    recipientId: recipient,
    actorId: ACTOR,
    type,
    entityType: 'post',
    entityId,
    read: false,
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
});

afterEach(async () => {
  await clearPostScope(scope);
  if (createdRecipientIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.recipientId, createdRecipientIds));
    createdRecipientIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /notifications post privacy', () => {
  it.each([
    ['a private post', { visibility: PostVisibility.PRIVATE }],
    ['a followers-only post', { visibility: PostVisibility.FOLLOWERS_ONLY }],
    ['an unpublished draft', { status: 'draft' as const }],
  ])('keeps the row but never previews %s', async (_label, overrides) => {
    const viewer = viewerId();
    const postId = await seedReferencedPost(RAW_PRIVATE_TEXT, overrides);
    await seedNotification(viewer, postId);

    const response = await request(makeApp(viewer)).get('/').expect(200);

    // The notification survives — the viewer still learns someone engaged.
    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].preview).toBeUndefined();
    expect(response.body.notifications[0].post).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(RAW_PRIVATE_TEXT);
  });

  it('hands hydration the whole record and the VIEWER’s scope', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost('an ordinary public post');
    await seedNotification(viewer, postId);

    await request(makeApp(viewer)).get('/').expect(200);

    // `maxDepth: 1` is not decoration: a boost carries an empty body and renders
    // only through its embedded original, so a depth-0 preview would be blank.
    expect(mocks.hydratePosts).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: postId, oxyUserId: ACTOR })]),
      expect.objectContaining({ viewerId: viewer, maxDepth: 1, includeLinkMetadata: true }),
    );
  });

  it('fails the whole page closed when viewer-aware hydration cannot resolve privacy', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost(RAW_PRIVATE_TEXT);
    await seedNotification(viewer, postId);
    // `…Once`, deliberately: `vi.clearAllMocks()` clears recorded CALLS and not
    // implementations, so a durable rejection here would silently 500 every
    // test declared after this one — as a page of unrelated failures that all
    // look like the route being broken.
    mocks.hydratePosts.mockRejectedValueOnce(new Error('privacy authority unavailable'));

    const response = await request(makeApp(viewer)).get('/').expect(500);

    // A partially enriched page would make a transient outage of the privacy
    // authority indistinguishable from authorization success.
    expect(response.body.notifications).toEqual([]);
    expect(response.body.hasMore).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain(RAW_PRIVATE_TEXT);
  });

  it('builds the preview from the authorized hydrated DTO', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost('an authorized public body');
    await seedNotification(viewer, postId);

    const response = await request(makeApp(viewer)).get('/').expect(200);

    expect(response.body.notifications[0].preview).toBe('an authorized public body');
  });

  it('truncates a long preview rather than shipping the whole body', async () => {
    const viewer = viewerId();
    const long = 'x'.repeat(500);
    const postId = await seedReferencedPost(long);
    await seedNotification(viewer, postId);

    const response = await request(makeApp(viewer)).get('/').expect(200);

    expect(response.body.notifications[0].preview).toBe(`${'x'.repeat(200)}…`);
  });

  it('embeds the hydrated post only for a `post` notification', async () => {
    // The full embed stays gated to `type:'post'`; a like resolves the cheap
    // text preview and nothing more.
    const viewer = viewerId();
    const postId = await seedReferencedPost('an announcement');
    await seedNotification(viewer, postId, 'post');

    const response = await request(makeApp(viewer)).get('/').expect(200);

    expect(response.body.notifications[0].post).toMatchObject({ id: postId });
  });

  it('resolves no preview at all for a like whose post was deleted', async () => {
    // A dangling `entityId` is ordinary: `deletePost` does not rewrite the
    // notifications that pointed at it. The row must survive with no preview
    // rather than 500 the page.
    const viewer = viewerId();
    await seedNotification(viewer, '019616a0-0000-7000-8000-0000deadbeef');

    const response = await request(makeApp(viewer)).get('/').expect(200);

    expect(response.body.notifications).toHaveLength(1);
    expect(response.body.notifications[0].preview).toBeUndefined();
  });
});

describe('GET /notifications degraded actor identity', () => {
  it('uses a neutral actor when the Oxy bulk lookup misses', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost('anything');
    await seedNotification(viewer, postId);
    mocks.getUsersByIds.mockResolvedValue([]);

    const response = await request(makeApp(viewer)).get('/').expect(200);
    const actor = response.body.notifications[0].actorId_populated;

    // The ghost-handle rule: an unresolved actor NEVER gets its raw Oxy id
    // rendered as a handle, because that becomes a `/@<id>` link to nowhere.
    expect(actor).toMatchObject({
      _id: ACTOR,
      username: '',
      name: { displayName: 'Unknown user' },
    });
  });

  it('uses a neutral actor when Oxy is unavailable', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost('anything');
    await seedNotification(viewer, postId);
    mocks.getUsersByIds.mockRejectedValue(new Error('oxy unavailable'));

    const response = await request(makeApp(viewer)).get('/').expect(200);
    const actor = response.body.notifications[0].actorId_populated;

    // An Oxy outage degrades the actor; it never fails the page, and it never
    // takes the notification away.
    expect(actor).toMatchObject({
      _id: ACTOR,
      username: '',
      name: { displayName: 'Unknown user' },
    });
  });

  it('renders the resolved actor when Oxy answers', async () => {
    // The vacuity floor for the two cases above.
    const viewer = viewerId();
    const postId = await seedReferencedPost('anything');
    await seedNotification(viewer, postId);
    mocks.getUsersByIds.mockResolvedValue([
      { id: ACTOR, username: 'realactor', name: { displayName: 'Real Actor' } },
    ]);

    const response = await request(makeApp(viewer)).get('/').expect(200);

    expect(response.body.notifications[0].actorId_populated).toMatchObject({
      _id: ACTOR,
      username: 'realactor',
    });
  });
});
