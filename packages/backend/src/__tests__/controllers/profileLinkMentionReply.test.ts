import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE REPLY AND THE BOOST COMMENT ARE WRITE BOUNDARIES TOO.
 *
 * `feed.controller` persists both documents itself rather than through
 * `PostCreationService`, so each carries its own copy of the mention
 * reconciliation — and would have carried its own omission of the profile-link
 * fold. A rule that holds for `POST /posts` and not for a reply is not a rule;
 * it is a coincidence of which handler somebody edited.
 *
 * These pin both, driven through the real handlers: the stored document's
 * `mentions` carries the id a pasted profile link named, and its body carries the
 * placeholder — plus the must-stay-a-link case on the reply path.
 *
 * The rows are REAL rows, read back out of Postgres after the handler answered.
 * Both handlers write through `db/posts/postRepository` now, so the `new Post(...)`
 * double this replaces intercepted nothing — every case here would have died on
 * an absent connection rather than on the mention conversion it is about. Reading
 * the row back also makes the assertion about what the database HOLDS rather than
 * about the object the handler assembled: the body lives in `post_contents` and
 * the allowlist in `post_mentions`, so a fold that never reached either table
 * fails here instead of passing on the argument it was handed.
 *
 * Same seams as the sibling `services/profileLinkMentionWrites.test.ts`: the
 * local-handle lookup (`resolveOxyUser`) and the stored-actor repository are
 * stubbed, since profile-link resolution has to be answerable without network or
 * Oxy I/O — everything else about the fold is the real code.
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
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown user' } }),
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
import { clearServiceScope, readPost, readScopePosts, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { feedController } from '../../controllers/feed.controller';

const scope = serviceScope('profile-link-mention-reply');

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

/** The one row this scope's accounts own that answers `match`, as stored. */
async function writtenPost(
  match: (row: { parentPostId: string | null; boostOf: string | null }) => boolean,
): Promise<{ mentions: string[]; text: string }> {
  const rows = (await readScopePosts(scope)).filter(match);
  expect(rows).toHaveLength(1);
  const stored = await readPost(rows[0].id);
  return {
    mentions: stored?.mentions ?? [],
    text: stored?.content.variants?.[0]?.text ?? '',
  };
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
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

describe('createReply — a pasted profile link becomes a real mention', () => {
  it('stores the id and rewrites the reply body to the placeholder', async () => {
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
    expect(await writtenPost((row) => row.parentPostId === parent.id)).toEqual({
      mentions: [ALICE_OXY_ID],
      text: `agreed, [mention:${ALICE_OXY_ID}]`,
    });
  });

  it('leaves a link it cannot resolve as a link, and mentions nobody', async () => {
    const parent = await seedPost(scope, { oxyUserId: PARENT_AUTHOR_ID });
    const { res, captured } = buildResponse();

    await feedController.createReply(
      {
        body: { postId: parent.id, content: { text: 'see https://mastodon.social/@a-stranger' } },
        user: { id: USER_ID },
      } as never,
      res as never,
    );

    expect(captured.status).toBe(201);
    expect(await writtenPost((row) => row.parentPostId === parent.id)).toEqual({
      mentions: [],
      text: 'see https://mastodon.social/@a-stranger',
    });
  });
});

describe('createBoost — the comment on a boost is a body like any other', () => {
  it('stores the id and rewrites the comment to the placeholder', async () => {
    const original = await seedPost(scope, { oxyUserId: PARENT_AUTHOR_ID });
    const { res, captured } = buildResponse();

    await feedController.createBoost(
      {
        body: { originalPostId: original.id, content: { text: `look, https://${OWN_HOST}/@alice` } },
        user: { id: USER_ID },
      } as never,
      res as never,
    );

    expect(captured.status).toBe(201);
    expect(await writtenPost((row) => row.boostOf === original.id)).toEqual({
      mentions: [ALICE_OXY_ID],
      text: `look, [mention:${ALICE_OXY_ID}]`,
    });
  });
});
