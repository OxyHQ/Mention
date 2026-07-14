import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const ACTOR_URI = 'https://mastodon.social/users/bob';
const OTHER_ACTOR_URI = 'https://evil.example/users/mallory';
const OWNER_OXY_ID = 'oxy_bob';

const mocks = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
  signRequest: vi.fn(),
  actorFindOne: vi.fn(),
  followExists: vi.fn(),
  postFindOne: vi.fn(),
  postExists: vi.fn(),
  postUpdateOne: vi.fn(),
  postDeleteOne: vi.fn(),
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

vi.mock('../../../models/FederatedActor', () => ({
  default: { findOne: mocks.actorFindOne },
}));

vi.mock('../../../models/FederatedFollow', () => ({
  default: { exists: mocks.followExists },
}));

vi.mock('../../../models/FederationDeliveryQueue', () => ({
  default: {},
  getNextRetryTime: vi.fn(),
}));

vi.mock('../../../models/Post', () => ({
  POST_CLASSIFICATION_PENDING: 'pending',
  Post: {
    findOne: mocks.postFindOne,
    exists: mocks.postExists,
    updateOne: mocks.postUpdateOne,
    deleteOne: mocks.postDeleteOne,
  },
}));

vi.mock('../../../models/Like', () => ({
  default: {
    create: mocks.likeCreate,
    findOneAndDelete: mocks.likeFindOneAndDelete,
  },
}));

vi.mock('../../../models/UserSettings', () => ({
  default: { updateOne: vi.fn() },
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

beforeEach(() => {
  vi.clearAllMocks();
  // The edited post is found (scoped lookup) and belongs to a local-linked owner.
  mocks.postFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue({ oxyUserId: OWNER_OXY_ID }) });
  mocks.postUpdateOne.mockResolvedValue({ modifiedCount: 1 });
});

describe('handleUpdate — NoSQL-injection safety + ownership scope', () => {
  it('recovers a contentMap-only edit and scopes both queries to the sending actor', async () => {
    await inboxProcessingService.processInboxActivity(updateActivity(), ACTOR_URI);

    // The lookup is scoped by BOTH the activity id and the sending actor.
    expect(mocks.postFindOne).toHaveBeenCalledWith(
      { 'federation.activityId': EDITED_NOTE_ID, 'federation.actorUri': ACTOR_URI },
      { oxyUserId: 1 },
    );

    expect(mocks.postUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = mocks.postUpdateOne.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    // Ownership scope: the write can only match the sender's OWN post.
    expect(filter).toEqual({
      'federation.activityId': EDITED_NOTE_ID,
      'federation.actorUri': ACTOR_URI,
    });
    // Body recovered from the contentMap variant (empty top-level content) and
    // stored in its only home — the renditions.
    expect(update.$set['content.variants']).toEqual([
      { tag: 'es', source: 'author', text: 'texto editado' },
    ]);
  });

  it('scopes the update to the sending actor so a replayed activityId cannot overwrite another actor’s post', async () => {
    // A different verified sender replays the SAME note id.
    await inboxProcessingService.processInboxActivity(
      updateActivity({ attributedTo: OTHER_ACTOR_URI }),
      OTHER_ACTOR_URI,
    );

    expect(mocks.postUpdateOne).toHaveBeenCalledTimes(1);
    const [filter] = mocks.postUpdateOne.mock.calls[0] as [Record<string, unknown>];
    // The filter carries the REPLAYER's actorUri, so it only ever matches that
    // actor's own post — never the original author's row.
    expect(filter).toEqual({
      'federation.activityId': EDITED_NOTE_ID,
      'federation.actorUri': OTHER_ACTOR_URI,
    });
  });

  it('ignores an Update whose object.id is not a string (no updateOne, no injectable filter)', async () => {
    // A non-string id (operator payload) must never reach a Mongo filter. It is
    // rejected by schema validation upstream AND the explicit handler string
    // guard — either way, no write is issued.
    await inboxProcessingService.processInboxActivity(
      updateActivity({ id: { $gt: '' } }),
      ACTOR_URI,
    );

    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
  });
});
