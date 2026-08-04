/**
 * `GET /notifications` — the two per-viewer safety gates, end to end.
 *
 * Four clauses are documented in `AGENTS.md` and each one is separately easy to
 * get backwards, so each has a test that fails if it is:
 *
 *  1. a sensitivity-gated post WITHHOLDS the preview/embed but KEEPS the row —
 *     the viewer still learns someone replied;
 *  2. a muted post is REMOVED entirely — blanking the text would still announce
 *     the interaction and invite a tap through to the muted content;
 *  3. neither applies to a post the viewer AUTHORED (`viewerState.isOwner` /
 *     `isCollaborator`) — a mute must never hide engagement on your own work;
 *  4. `unreadCount` is a separate aggregate and still counts a removed row.
 *
 * ## What is real here, and why each piece has to be
 *
 * The suite this replaces mocked `models/Post`, so the "sensitive post" under
 * test was a literal the test wrote and handed straight back. The route now
 * reads `loadPostRecords` and asks `requiresContentWarning` about the RAW
 * record, so the post is a real row and each sensitivity signal is a real
 * column: a gate that stopped reading one of them fails here.
 *
 * Ownership is real for the same reason and it matters more. `viewerState.isOwner`
 * is derived by `PostHydrationService` from the `post_authorships` rows, so
 * clause 3 is decided by who actually wrote the post rather than by a literal in
 * the test — the shape a stub gets to assert either way. Hydration therefore
 * runs for real; only Oxy (a foreign HTTP service) and the Redis summary cache
 * are stubbed.
 *
 * The viewer's preferences are real rows too:
 * `user_settings.privacy_show_sensitive_content` and `mute_words`, read back
 * through `services/safety/viewerSafety`.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  getUserFollowing: vi.fn(),
  loadFollowedAuthorIds: vi.fn(),
}));

vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: () => ({ getUserFollowing: mocks.getUserFollowing }),
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
// viewer" so these cases stay about the sensitive-content and muted-word gates.
// Pinned rather than left real: the live resolver reads Redis and Oxy, neither
// of which decides anything this file asserts.
vi.mock('../../services/notificationInbox', () => ({
  resolveNotificationInboxIds: async (viewerId: string) => [viewerId],
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById: vi.fn(async () => null),
    getUserFollowing: mocks.getUserFollowing,
    getUserFollowers: vi.fn(async () => []),
  }),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: (value: unknown) =>
    (Array.isArray(value) ? value : []).map((entry) => (entry as { id: string }).id),
  extractFollowersIds: vi.fn(() => []),
}));

// Redis. A miss is the honest default and forces the cold Oxy path above.
vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async () => new Map()),
  mset: vi.fn(async () => undefined),
}));

/**
 * A SPY over the real `loadFollowedAuthorIds`, not a stub.
 *
 * "Did the route load the follow graph?" cannot be observed through the Oxy
 * client: hydration calls `getUserFollowing` on its own for the viewer context,
 * so a bare call count answers a wider question than the one asked and reports
 * the lazy-load rule as broken when it is not. Wrapping the real function keeps
 * the union it computes (Oxy ∪ accepted federated follows) real while making
 * the route's own decision to call it observable.
 */
vi.mock('../../services/viewerFollowGraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/viewerFollowGraph')>();
  mocks.loadFollowedAuthorIds.mockImplementation(actual.loadFollowedAuthorIds);
  return { ...actual, loadFollowedAuthorIds: mocks.loadFollowedAuthorIds };
});

vi.mock('../../utils/push', () => ({
  sendPushToUser: vi.fn(),
  formatPushForNotification: vi.fn(),
}));

import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres';
import { uuidv7 } from '../../db/schema/columns';
import { notifications } from '../../db/schema/discovery';
import { muteWords } from '../../db/schema/engagement';
import { userSettings } from '../../db/schema/userProfile';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import notificationsRouter from '../../routes/notifications';

const scope = postScope('notifications-safety');
const ACTOR = scope.user('actor');

let db: Database;
const createdViewerIds: string[] = [];

const SENSITIVE_TEXT = 'graphic description nobody asked to read';
const MUTED_TEXT = 'massive spoilers for the finale';

type NotificationType = 'like' | 'reply' | 'mention' | 'post';

function viewerId(): string {
  const id = `oxy-safety-viewer-${randomUUID()}`;
  createdViewerIds.push(id);
  return id;
}

/**
 * A real referenced post, authored by {@link ACTOR} unless a case is about the
 * viewer's own work.
 */
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

async function seedNotification(viewer: string, type: NotificationType, entityId: string) {
  await db.insert(notifications).values({
    // A fresh id per row: suites share one database and run in parallel, so a
    // fixed primary key collides across files rather than across tests.
    id: uuidv7(),
    recipientId: viewer,
    actorId: ACTOR,
    type,
    entityType: type === 'reply' ? 'reply' : 'post',
    entityId,
    read: false,
  });
}

/** The viewer's stored sensitive-content opt-in — a real `user_settings` row. */
async function optIntoSensitiveContent(viewer: string) {
  await db.insert(userSettings).values({
    oxyUserId: viewer,
    privacyShowSensitiveContent: true,
  });
}

/** A real `mute_words` row, read back by `loadMuteWords`. */
async function seedMuteWord(
  viewer: string,
  value: string,
  targets: string[],
  actorTarget: 'all' | 'exclude-following' = 'all',
) {
  await db.insert(muteWords).values({ userId: viewer, value, targets, actorTarget });
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

interface NotificationsBody {
  notifications: Array<{
    type: string;
    preview?: string;
    post?: { id: string };
  }>;
  unreadCount: number;
}

async function fetchPage(viewer: string): Promise<NotificationsBody> {
  const res = await request(makeApp(viewer)).get('/').expect(200);
  return res.body as NotificationsBody;
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUsersByIds.mockResolvedValue([
    { id: ACTOR, username: 'actor', name: { displayName: 'Actor' } },
  ]);
  mocks.getUserFollowing.mockResolvedValue([]);
});

afterEach(async () => {
  await clearPostScope(scope);
  if (createdViewerIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.recipientId, createdViewerIds));
    await db.delete(muteWords).where(inArray(muteWords.userId, createdViewerIds));
    await db.delete(userSettings).where(inArray(userSettings.oxyUserId, createdViewerIds));
    createdViewerIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /notifications sensitive-content gating', () => {
  it('withholds the preview text of a sensitive reply from a viewer who has not opted in', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost(SENSITIVE_TEXT, { metadata: { isSensitive: true } });
    await seedNotification(viewer, 'reply', postId);

    const body = await fetchPage(viewer);

    // The notification itself survives — the viewer still learns someone replied.
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].type).toBe('reply');
    expect(body.notifications[0].preview).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(SENSITIVE_TEXT);
  });

  it('withholds the preview of a post the classifier marked sensitive', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost(SENSITIVE_TEXT, {
      postClassification: { sensitive: true },
    });
    await seedNotification(viewer, 'reply', postId);

    const body = await fetchPage(viewer);

    expect(body.notifications[0].preview).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(SENSITIVE_TEXT);
  });

  it('withholds the preview of a post carrying a federated content warning', async () => {
    // `requiresContentWarning` is WIDER than the feed gate: a plain-text preview
    // cannot render the CW that makes this safe to show in-app.
    const viewer = viewerId();
    const postId = await seedReferencedPost(SENSITIVE_TEXT, {
      federation: {
        activityId: `https://remote.test/${scope.name}/cw`,
        spoilerText: 'CW: injury',
      },
    });
    await seedNotification(viewer, 'reply', postId);

    const body = await fetchPage(viewer);

    expect(body.notifications[0].preview).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(SENSITIVE_TEXT);
  });

  it('withholds the preview of a post the remote instance flagged sensitive', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost(SENSITIVE_TEXT, {
      federation: {
        activityId: `https://remote.test/${scope.name}/flagged`,
        sensitive: true,
      },
    });
    await seedNotification(viewer, 'reply', postId);

    expect((await fetchPage(viewer)).notifications[0].preview).toBeUndefined();
  });

  it('withholds the preview of a post tagged with an NSFW hashtag', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost(SENSITIVE_TEXT, { hashtags: ['nsfw'] });
    await seedNotification(viewer, 'reply', postId);

    expect((await fetchPage(viewer)).notifications[0].preview).toBeUndefined();
  });

  it('shows the preview once the viewer has opted into sensitive content', async () => {
    const viewer = viewerId();
    await optIntoSensitiveContent(viewer);
    const postId = await seedReferencedPost(SENSITIVE_TEXT, { metadata: { isSensitive: true } });
    await seedNotification(viewer, 'reply', postId);

    expect((await fetchPage(viewer)).notifications[0].preview).toBe(SENSITIVE_TEXT);
  });

  it('still previews the viewer’s OWN sensitive post, which is no surprise to its author', async () => {
    const viewer = viewerId();
    // Authored by the VIEWER, so `viewerState.isOwner` comes out of the stored
    // authorship row rather than out of a literal in this test.
    const postId = await seedReferencedPost(SENSITIVE_TEXT, {
      oxyUserId: viewer,
      metadata: { isSensitive: true },
    });
    await seedNotification(viewer, 'like', postId);

    expect((await fetchPage(viewer)).notifications[0].preview).toBe(SENSITIVE_TEXT);
  });

  it('drops the embedded post of a sensitive `post` notification, not just the preview', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost(SENSITIVE_TEXT, { metadata: { isSensitive: true } });
    await seedNotification(viewer, 'post', postId);

    const body = await fetchPage(viewer);

    expect(body.notifications[0].post).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(SENSITIVE_TEXT);
  });

  it('embeds the hydrated post of an UNGATED `post` notification', async () => {
    // The vacuity floor for the case above: the embed has to be reachable at
    // all, or "no embed" proves nothing about the gate.
    const viewer = viewerId();
    const postId = await seedReferencedPost('an ordinary announcement');
    await seedNotification(viewer, 'post', postId);

    const body = await fetchPage(viewer);

    expect(body.notifications[0].post).toMatchObject({ id: postId });
    expect(body.notifications[0].preview).toBe('an ordinary announcement');
  });
});

describe('GET /notifications muted words', () => {
  it('removes a reply notification whose post contains a term the viewer muted', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost(MUTED_TEXT);
    await seedNotification(viewer, 'reply', postId);
    await seedMuteWord(viewer, 'spoilers', ['content', 'tag']);

    const body = await fetchPage(viewer);

    expect(body.notifications).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('spoilers');
  });

  it('still counts a removed notification in unreadCount', async () => {
    // `unreadCount` is a separate aggregate over the recipient's unread rows;
    // muting is a READ-time rule and does not un-write the row it hides.
    const viewer = viewerId();
    const postId = await seedReferencedPost(MUTED_TEXT);
    await seedNotification(viewer, 'reply', postId);
    await seedMuteWord(viewer, 'spoilers', ['content']);

    const body = await fetchPage(viewer);

    expect(body.notifications).toEqual([]);
    expect(body.unreadCount).toBe(1);
  });

  it('removes a mention notification whose post carries a muted hashtag', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost('election night', { hashtags: ['politics'] });
    await seedNotification(viewer, 'mention', postId);
    await seedMuteWord(viewer, 'politics', ['tag']);

    expect((await fetchPage(viewer)).notifications).toEqual([]);
  });

  it('keeps a like on the viewer’s OWN post even when it matches their muted word', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost(MUTED_TEXT, { oxyUserId: viewer });
    await seedNotification(viewer, 'like', postId);
    await seedMuteWord(viewer, 'spoilers', ['content']);

    const body = await fetchPage(viewer);

    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].type).toBe('like');
  });

  it('keeps engagement on a post the viewer COLLABORATED on', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost(MUTED_TEXT, {
      oxyUserId: ACTOR,
      authorship: [
        { oxyUserId: ACTOR, role: 'owner', status: 'accepted' },
        { oxyUserId: viewer, role: 'collaborator', status: 'accepted' },
      ],
    });
    await seedNotification(viewer, 'like', postId);
    await seedMuteWord(viewer, 'spoilers', ['content']);

    expect((await fetchPage(viewer)).notifications).toHaveLength(1);
  });

  it('does NOT treat a still-pending collaborator invite as the viewer’s own work', async () => {
    // `isCollaborator` requires an ACCEPTED entry. A pending invitee has not
    // consented to co-author anything, so their mute still applies.
    const viewer = viewerId();
    const postId = await seedReferencedPost(MUTED_TEXT, {
      oxyUserId: ACTOR,
      authorship: [
        { oxyUserId: ACTOR, role: 'owner', status: 'accepted' },
        { oxyUserId: viewer, role: 'collaborator', status: 'pending' },
      ],
    });
    await seedNotification(viewer, 'like', postId);
    await seedMuteWord(viewer, 'spoilers', ['content']);

    expect((await fetchPage(viewer)).notifications).toEqual([]);
  });

  it('keeps a reply from a followed author when the muted word excludes follows', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost(MUTED_TEXT);
    await seedNotification(viewer, 'reply', postId);
    await seedMuteWord(viewer, 'spoilers', ['content'], 'exclude-following');
    mocks.getUserFollowing.mockResolvedValue([{ id: ACTOR }]);

    const body = await fetchPage(viewer);

    expect(mocks.loadFollowedAuthorIds).toHaveBeenCalledWith(viewer, expect.anything());
    expect(body.notifications).toHaveLength(1);
  });

  it('does not pay for the follow-graph lookup when no muted word needs it', async () => {
    const viewer = viewerId();
    const postId = await seedReferencedPost('an ordinary reply');
    await seedNotification(viewer, 'reply', postId);
    await seedMuteWord(viewer, 'spoilers', ['content']);

    await fetchPage(viewer);

    expect(mocks.loadFollowedAuthorIds).not.toHaveBeenCalled();
  });

  it('leaves an unmuted viewer’s notifications alone', async () => {
    // The vacuity floor: every case above must not be passing because the page
    // is empty for everyone.
    const viewer = viewerId();
    const postId = await seedReferencedPost(MUTED_TEXT);
    await seedNotification(viewer, 'reply', postId);

    const body = await fetchPage(viewer);

    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].preview).toBe(MUTED_TEXT);
  });
});
