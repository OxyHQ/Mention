import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A REPLY OR A BOOST SENT FROM THE APP NOTIFIES THE PEOPLE IT CONCERNS.
 *
 * The app sends replies to `POST /feed/reply` and boosts to `POST /feed/boost`,
 * and both handlers write their rows through the repository directly rather than
 * through `PostCreationService`. The notification fan-out lived only in the
 * service, so for as long as these handlers existed a reply notified nobody —
 * not the parent's author, not the people it @mentioned — and a boost never
 * told the original's author. Follows kept arriving (a different writer), which
 * is what made the silence look like a delivery problem rather than a missing
 * write.
 *
 * Driven through the real handlers against real rows; the notification writers
 * are the seam, so what is asserted is WHO the handler asked to be notified.
 * The fan-out is detached, so each case drains the background work first.
 */

const hoisted = vi.hoisted(() => ({
  isBlockedDomain: vi.fn((_host: string) => false),
  resolveOxyUser: vi.fn(),
  findActorByUri: vi.fn(),
  findActorByAcct: vi.fn(),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (rows: unknown[]) => rows) },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: (id: string) => ({
    id,
    username: '',
    name: { displayName: 'Unknown user' },
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  getServiceOxyClient: vi.fn(() => ({})),
}));

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  createBatchNotifications: vi.fn().mockResolvedValue(undefined),
  createPostAuthorNotifications: vi.fn().mockResolvedValue(undefined),
}));

// The signed-record dual write. `createBoost` AWAITS `emitRepostCreated` outside
// any try/catch, so leaving the real one in place hangs the boost case rather
// than failing it.
vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: vi.fn().mockResolvedValue(undefined),
  emitRepostCreated: vi.fn().mockResolvedValue(undefined),
  emitTombstone: vi.fn(),
  repostRecordUri: () => 'at://test',
}));

vi.mock('../../services/PostRecentReplierService', () => ({
  recordRecentReplierForPost: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/AffinityEventService', () => ({
  affinityEventService: { record: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../services/UserPreferenceService', () => ({
  userPreferenceService: { recordInteraction: vi.fn().mockResolvedValue(undefined) },
  readInteractionSurface: vi.fn(() => undefined),
}));

vi.mock('../../connectors/outboundFederation', () => ({
  federateAsResolvedActor: vi.fn(),
}));

vi.mock('../../services/postEngagementBroadcast', () => ({
  emitPostEngagement: vi.fn(),
  POST_ENGAGEMENT_EVENTS: {
    LIKED: 'post:liked',
    UNLIKED: 'post:unliked',
    BOOSTED: 'post:boosted',
    UNBOOSTED: 'post:unboosted',
    SAVED: 'post:saved',
    UNSAVED: 'post:unsaved',
    REPLIED: 'post:replied',
  },
}));

// PARTIAL: the controller pulls the whole connector graph in, and `actor.service`
// reads `FEDERATION_ENABLED` off this module at import time.
vi.mock('../../connectors/activitypub/constants', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isBlockedDomain: hoisted.isBlockedDomain,
  resolveOxyUser: hoisted.resolveOxyUser,
}));

// PARTIAL, and only the two point lookups `resolveProfileLinkIdentity` spends on
// a foreign profile link (uri first, then acct). Everything else the connector
// graph reads from this repository stays real, against the same database the
// posts are written to.
vi.mock('../../db/federation/actorRepository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/federation/actorRepository')>()),
  findActorByUri: hoisted.findActorByUri,
  findActorByAcct: hoisted.findActorByAcct,
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  clearServiceScope,
  readScopePosts,
  seedPost,
  serviceScope,
} from '../helpers/serviceFixtures';
import { feedController } from '../../controllers/feed.controller';
import { drainBackgroundWork, resetBackgroundWorkForTests } from '../../runtime/backgroundWork';
import {
  createMentionNotifications,
  createPostAuthorNotifications,
} from '../../utils/notificationUtils';

const scope = serviceScope('reply-boost-notifications');

const OWN_HOST = 'mention.earth';
const USER_ID = scope.user('replier');
const PARENT_AUTHOR_ID = scope.user('parent-author');
const ALICE_OXY_ID = scope.user('alice-local');

function buildResponse() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

async function onlyWrittenPostId(
  match: (row: { parentPostId: string | null; boostOf: string | null }) => boolean,
): Promise<string> {
  const rows = (await readScopePosts(scope)).filter(match);
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  resetBackgroundWorkForTests();
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.isBlockedDomain.mockImplementation(
    (host: string) => host.toLowerCase().replace(/^www\./, '') === OWN_HOST,
  );
  hoisted.resolveOxyUser.mockImplementation(async (username: string) =>
    username === 'alice' ? { _id: ALICE_OXY_ID } : null,
  );
  hoisted.findActorByUri.mockResolvedValue(null);
  hoisted.findActorByAcct.mockResolvedValue(null);
});

describe('POST /feed/reply', () => {
  it("notifies the parent's author of the reply", async () => {
    const parent = await seedPost(scope, { oxyUserId: PARENT_AUTHOR_ID });
    const { res, captured } = buildResponse();

    await feedController.createReply(
      {
        body: { postId: parent.id, content: { text: 'nice post' } },
        user: { id: USER_ID },
      } as never,
      res as never,
    );
    expect(captured.status).toBe(201);
    expect(await drainBackgroundWork(10_000)).toBe(true);

    const replyId = await onlyWrittenPostId((row) => row.parentPostId === parent.id);
    expect(vi.mocked(createPostAuthorNotifications)).toHaveBeenCalledTimes(1);
    const [authorship, notification] = vi.mocked(createPostAuthorNotifications).mock.calls[0];
    expect(authorship).toEqual([
      expect.objectContaining({ oxyUserId: PARENT_AUTHOR_ID, role: 'owner' }),
    ]);
    expect(notification).toEqual({
      actorId: USER_ID,
      type: 'reply',
      entityId: replyId,
      entityType: 'reply',
    });
    expect(vi.mocked(createMentionNotifications)).not.toHaveBeenCalled();
  });

  it('notifies everyone the reply @mentions, as a mention in a reply', async () => {
    const parent = await seedPost(scope, { oxyUserId: PARENT_AUTHOR_ID });
    const { res, captured } = buildResponse();

    await feedController.createReply(
      {
        body: { postId: parent.id, content: { text: `agreed, https://${OWN_HOST}/@alice` } },
        user: { id: USER_ID },
      } as never,
      res as never,
    );
    expect(captured.status).toBe(201);
    expect(await drainBackgroundWork(10_000)).toBe(true);

    const replyId = await onlyWrittenPostId((row) => row.parentPostId === parent.id);
    expect(vi.mocked(createMentionNotifications)).toHaveBeenCalledWith(
      [ALICE_OXY_ID],
      replyId,
      USER_ID,
      'reply',
    );
  });
});

describe('POST /feed/boost', () => {
  it("notifies the original's author of the boost", async () => {
    const original = await seedPost(scope, { oxyUserId: PARENT_AUTHOR_ID });
    const { res, captured } = buildResponse();

    await feedController.createBoost(
      { body: { originalPostId: original.id }, user: { id: USER_ID } } as never,
      res as never,
    );
    expect(captured.status).toBe(201);
    expect(await drainBackgroundWork(10_000)).toBe(true);

    expect(vi.mocked(createPostAuthorNotifications)).toHaveBeenCalledTimes(1);
    const [authorship, notification] = vi.mocked(createPostAuthorNotifications).mock.calls[0];
    expect(authorship).toEqual([
      expect.objectContaining({ oxyUserId: PARENT_AUTHOR_ID, role: 'owner' }),
    ]);
    expect(notification).toEqual({
      actorId: USER_ID,
      type: 'boost',
      entityId: original.id,
      entityType: 'post',
    });
  });

  it('does not notify again when the boost is refused as a repeat', async () => {
    const original = await seedPost(scope, { oxyUserId: PARENT_AUTHOR_ID });

    const first = buildResponse();
    await feedController.createBoost(
      { body: { originalPostId: original.id }, user: { id: USER_ID } } as never,
      first.res as never,
    );
    expect(first.captured.status).toBe(201);
    expect(await drainBackgroundWork(10_000)).toBe(true);
    vi.mocked(createPostAuthorNotifications).mockClear();

    const second = buildResponse();
    await feedController.createBoost(
      { body: { originalPostId: original.id }, user: { id: USER_ID } } as never,
      second.res as never,
    );
    expect(second.captured.status).toBe(400);
    expect(await drainBackgroundWork(10_000)).toBe(true);
    expect(vi.mocked(createPostAuthorNotifications)).not.toHaveBeenCalled();
  });
});
