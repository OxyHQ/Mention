import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedFollow,
  seedPost,
} from '../../helpers/federationFixtures';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../../../db/postgres';
import { postContentVariants } from '../../../db/schema/postContent';
import { posts } from '../../../db/schema/posts';
import type { PostRecord } from '../../../db/posts/postRecord';

const scope = federationScope('inbound-update-security');

/**
 * Security + edit-semantics coverage for `handleUpdate` (inbound AP `Update` of
 * a federated Note/Article).
 *
 * Two properties are asserted against the REAL `InboxProcessingService`
 * (same mocking convention as the sibling `inboundSharingGates.test.ts` — mock
 * the models + heavy deps, let `apSchemas` validation and the content builder
 * run for real):
 *  1. NoSQL-injection safety: the raw remote `object.id` must be a real string
 *     before it reaches any Mongo filter — a non-string id never issues a
 *     `Post.updateOne` (CodeQL `js/sql-injection`).
 *  2. Ownership scope: an Update only edits the SENDING actor's OWN post — every
 *     query is scoped by `federation.actorUri`, so a remote server can't
 *     overwrite another actor's post by replaying its activityId.
 * Plus an end-to-end check that an edited `contentMap`-only note recovers its
 * body through the shared builder.
 */

const ACTOR_URI = `${scope.origin}/users/bob`;
const OTHER_ACTOR_URI = `${scope.origin}/users/mallory`;
const OWNER_OXY_ID = scope.user('bob');

/** The post under edit for the test currently running. */
let edited: PostRecord;

/** The stored renditions, which is where a federated body actually lives. */
async function storedVariants(postId: string): Promise<Array<{ tag: string | null; body: string }>> {
  return getDb()
    .select({ tag: postContentVariants.tag, body: postContentVariants.body })
    .from(postContentVariants)
    .where(eq(postContentVariants.postId, postId))
    .orderBy(asc(postContentVariants.position));
}

const mocks = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
  signRequest: vi.fn(),
  likeCreate: vi.fn(),
  likeFindOneAndDelete: vi.fn(),
  postCreatorCreate: vi.fn(),
  ensureFederatedReplyLink: vi.fn(),
  importAnnounce: vi.fn(),
  isFediverseSharingEnabled: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: mocks.loggerDebug,
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../../connectors/activitypub/crypto', () => ({
  getPublicKey: mocks.getPublicKey,
  signViaOxy: mocks.signViaOxy,
  signRequest: mocks.signRequest,
}));

vi.mock('../../../models/FederationDeliveryQueue', () => ({
  default: {},
  getNextRetryTime: vi.fn(),
}));

vi.mock('../../../models/Like', () => ({
  default: {
    create: mocks.likeCreate,
    findOneAndDelete: mocks.likeFindOneAndDelete,
  },
}));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: vi.fn(),
}));

vi.mock('../../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: vi.fn(),
}));

vi.mock('../../../services/mediaCache/cacheStore', () => ({
  recordAccessAndMaybeEnqueue: vi.fn(),
}));

vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

vi.mock('../../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: (...args: unknown[]) => mocks.isFediverseSharingEnabled(...args),
}));

vi.mock('../../../connectors/activitypub/outbox.service', () => ({
  outboxSyncService: {
    ensureFederatedReplyLink: (...args: unknown[]) => mocks.ensureFederatedReplyLink(...args),
    importAnnounce: (...args: unknown[]) => mocks.importAnnounce(...args),
    syncOutboxPosts: vi.fn(),
  },
}));

import { inboxProcessingService } from '../../../connectors/activitypub/inbox.service';

const EDITED_NOTE_ID = `${ACTOR_URI}/statuses/900`;

/** A well-formed `Update` of an edited Note; `object` fields are overridable. */
function updateActivity(objectOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `${ACTOR_URI}/statuses/900/update/1`,
    type: 'Update',
    actor: ACTOR_URI,
    object: {
      id: EDITED_NOTE_ID,
      type: 'Note',
      attributedTo: ACTOR_URI,
      content: '',
      contentMap: { es: '<p>texto editado</p>' },
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      ...objectOverrides,
    },
  };
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFederationScope(scope);
  // The sending actor, resolved. `handleUpdate` falls back to it for the owner
  // id when the edited post has none.
  await seedActor(scope, { username: 'bob', uri: ACTOR_URI, oxyUserId: OWNER_OXY_ID, lastFetchedAt: new Date() });
  await seedFollow(scope, { remoteActorUri: ACTOR_URI, direction: 'outbound', status: 'accepted' });
  // The post being edited, as a REAL row owned by the SENDING actor. The
  // ownership scope is the security property here, and it is only expressible
  // against a row: the previous stub answered every lookup with the same
  // document whatever the filter said, so an unscoped write was indistinguishable
  // from a scoped one.
  edited = await seedPost(scope, {
    oxyUserId: OWNER_OXY_ID,
    content: { variants: [{ source: 'author', text: 'original', tag: 'en' }] },
    federation: { activityId: EDITED_NOTE_ID, actorUri: ACTOR_URI },
  });
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('handleUpdate — NoSQL-injection safety + ownership scope', () => {
  it('recovers a contentMap-only edit into the stored renditions', async () => {
    await inboxProcessingService.processInboxActivity(updateActivity(), ACTOR_URI);

    // Body recovered from the contentMap variant (top-level `content` is empty)
    // and written to its only home — the renditions. The original body is GONE
    // rather than merged: an edit replaces wholesale.
    expect(await storedVariants(edited.id)).toEqual([{ tag: 'es', body: 'texto editado' }]);
    const [row] = await getDb()
      .select({ isEdited: posts.isEdited })
      .from(posts)
      .where(eq(posts.id, edited.id));
    expect(row.isEdited).toBe(true);
  });

  it('scopes the update to the sending actor so a replayed activityId cannot overwrite another actor’s post', async () => {
    // A DIFFERENT verified sender replays the same note id. Without the
    // `federation.actor_uri` half of the predicate this matches the original
    // author's row — a remote server rewriting somebody else's post — and the
    // only way to see that is to read the row back afterwards.
    await inboxProcessingService.processInboxActivity(
      updateActivity({ attributedTo: OTHER_ACTOR_URI }),
      OTHER_ACTOR_URI,
    );

    expect(await storedVariants(edited.id)).toEqual([{ tag: 'en', body: 'original' }]);
    const [row] = await getDb()
      .select({ isEdited: posts.isEdited })
      .from(posts)
      .where(eq(posts.id, edited.id));
    expect(row.isEdited).toBe(false);
  });

  it('ignores an Update whose object.id is not a string (no updateOne, no injectable filter)', async () => {
    // A non-string id (operator payload) must never reach a Mongo filter. It is
    // rejected by schema validation upstream AND the explicit handler string
    // guard — either way, no write is issued.
    await inboxProcessingService.processInboxActivity(
      updateActivity({ id: { $gt: '' } }),
      ACTOR_URI,
    );

    expect(await storedVariants(edited.id)).toEqual([{ tag: 'en', body: 'original' }]);
  });
});
