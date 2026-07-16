import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound POLL VOTE federation: a remote Mastodon user voting on a LOCAL Mention
 * poll delivers a `Create(Note)` whose `name` is the chosen option, `inReplyTo`
 * is our poll's Question, and which carries NO content. `handleCreate` must
 * recognise that shape BEFORE the follower gate (a voter need not follow us) and
 * record the vote through the shared `pollVoteService` — resolving the remote
 * voter to a native Oxy user first (like `handleLike`).
 *
 * These pin:
 *   - a valid vote → `recordVoteByOptionText(pollId, optionName, voter)`, and the
 *     Create is CONSUMED (never materialized as a reply post);
 *   - a duplicate / after-close vote is still consumed, never throws, never
 *     creates a post (the shared service reports the reason);
 *   - a sharing-OFF poll owner or an unresolved voter is skipped (no recording);
 *   - a NON-vote Note (has content, or `inReplyTo` is not a poll) falls THROUGH to
 *     the normal reply path (reaches the follower gate), unchanged.
 *
 * Drives the REAL `InboxProcessingService`; `pollVoteService`, the actor
 * resolver, and the models are stubbed (same convention as the sibling
 * `inboundSharingGates.test.ts`). `resolvePostIdFromObjectUri` (helpers) runs for
 * real against the stubbed `Post` model.
 */

const ACTOR_URI = 'https://mastodon.social/users/bob';
const TARGET_POST_ID = '507f1f77bcf86cd799439011';
const TARGET_POST_URI = `https://mention.earth/ap/users/alice/posts/${TARGET_POST_ID}`;
const POLL_ID = 'poll-123';
const OWNER_OXY_ID = 'oxy_alice';
const VOTER_OXY_ID = 'oxy_bob';

const mocks = vi.hoisted(() => ({
  resolveActorOxyUserId: vi.fn(),
  getOrFetchActor: vi.fn(),
  recordVoteByOptionText: vi.fn(),
  isFediverseSharingEnabled: vi.fn(),
  followExists: vi.fn(),
  postFindOne: vi.fn(),
  postExists: vi.fn(),
  postCreatorCreate: vi.fn(),
  ensureFederatedReplyLink: vi.fn(),
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

vi.mock('../../../connectors/activitypub/actor.service', () => ({
  actorService: {
    resolveActorOxyUserId: (...args: unknown[]) => mocks.resolveActorOxyUserId(...args),
    getOrFetchActor: (...args: unknown[]) => mocks.getOrFetchActor(...args),
    refreshActorInBackground: vi.fn(),
    fetchRemoteActor: vi.fn(),
  },
}));

vi.mock('../../../connectors/activitypub/crypto', () => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
  signRequest: vi.fn(),
}));

vi.mock('../../../services/PollVoteService', () => ({
  pollVoteService: { recordVoteByOptionText: (...args: unknown[]) => mocks.recordVoteByOptionText(...args) },
}));

vi.mock('../../../models/FederatedActor', () => ({ default: { findOne: vi.fn() } }));
vi.mock('../../../models/FederatedFollow', () => ({ default: { exists: mocks.followExists } }));
vi.mock('../../../models/FederationDeliveryQueue', () => ({ default: {}, getNextRetryTime: vi.fn() }));

vi.mock('../../../models/Post', () => ({
  POST_CLASSIFICATION_PENDING: 'pending',
  Post: {
    findOne: mocks.postFindOne,
    exists: mocks.postExists,
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  },
}));

vi.mock('../../../models/Like', () => ({ default: { create: vi.fn(), findOneAndDelete: vi.fn() } }));
vi.mock('../../../models/UserSettings', () => ({ default: { updateOne: vi.fn() } }));
vi.mock('../../../utils/oxyHelpers', () => ({ getServiceOxyClient: vi.fn() }));
vi.mock('../../../services/mediaCache/cacheWorker', () => ({ persistRemoteMediaForFederatedOwnerDetailed: vi.fn() }));
vi.mock('../../../services/mediaCache/cacheStore', () => ({ recordAccessAndMaybeEnqueue: vi.fn() }));

vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

vi.mock('../../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: (...args: unknown[]) => mocks.isFediverseSharingEnabled(...args),
  isFediverseSharingEnabledFromUser: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/outbox.service', () => ({
  outboxSyncService: {
    ensureFederatedReplyLink: (...args: unknown[]) => mocks.ensureFederatedReplyLink(...args),
    importAnnounce: vi.fn(),
    syncOutboxPosts: vi.fn(),
  },
}));

import { inboxProcessingService } from '../../../connectors/activitypub/inbox.service';

/** A remote poll VOTE: a Note with `name` (chosen option), `inReplyTo` = our poll, no content. */
function voteActivity(optionName = 'Blue') {
  return {
    id: `${ACTOR_URI}/statuses/500/activity`,
    type: 'Create' as const,
    actor: ACTOR_URI,
    object: {
      id: `${ACTOR_URI}/statuses/500`,
      type: 'Note' as const,
      attributedTo: ACTOR_URI,
      name: optionName,
      inReplyTo: TARGET_POST_URI,
      to: ['https://mention.earth/ap/users/alice'],
    },
  };
}

/**
 * Route every `Post.findOne` by (filter, projection):
 *  - `resolvePostIdFromObjectUri` local-exists check (filter has `status`);
 *  - `resolvePostIdFromObjectUri` imported-post check (filter has `federation.activityId`);
 *  - `handlePollVote` pollId lookup (projection has `content.pollId`);
 *  - `isLocalPostOwnerSharingEnabled` owner lookup (bare `_id`).
 */
function stubPostFindOne(options: {
  localPostExists?: boolean;
  pollId?: string | null;
  owner?: { oxyUserId?: string | null; federation?: unknown } | null;
} = {}): void {
  const {
    localPostExists = true,
    pollId = POLL_ID,
    owner = { oxyUserId: OWNER_OXY_ID, federation: null },
  } = options;
  mocks.postFindOne.mockImplementation((filter: Record<string, unknown>, projection?: Record<string, unknown>) => ({
    lean: async () => {
      if ('status' in filter) return localPostExists ? { _id: filter._id } : null;
      if ('federation.activityId' in filter) return null;
      if (projection && 'content.pollId' in projection) return { content: pollId ? { pollId } : {} };
      return owner;
    },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActorOxyUserId.mockResolvedValue(VOTER_OXY_ID);
  mocks.recordVoteByOptionText.mockResolvedValue({ ok: true, poll: { _id: POLL_ID } });
  mocks.isFediverseSharingEnabled.mockResolvedValue(true);
  mocks.followExists.mockResolvedValue(null);
  mocks.postExists.mockResolvedValue(null);
  mocks.postCreatorCreate.mockResolvedValue({ _id: 'created_post_1' });
  mocks.ensureFederatedReplyLink.mockResolvedValue({ parentPostId: TARGET_POST_ID, threadId: TARGET_POST_ID });
  stubPostFindOne();
});

describe('handlePollVote — recording a remote vote on a local poll', () => {
  it('resolves the voter and records the vote by option name; the Create is consumed (no reply post)', async () => {
    await inboxProcessingService.processInboxActivity(voteActivity('Blue'), ACTOR_URI);

    expect(mocks.isFediverseSharingEnabled).toHaveBeenCalledWith(OWNER_OXY_ID);
    expect(mocks.resolveActorOxyUserId).toHaveBeenCalledWith(ACTOR_URI);
    expect(mocks.recordVoteByOptionText).toHaveBeenCalledWith(POLL_ID, 'Blue', VOTER_OXY_ID);
    // A vote is never materialized as a reply post, and never reaches the follower gate.
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    expect(mocks.followExists).not.toHaveBeenCalled();
  });

  it('consumes a duplicate vote without error and without creating a post', async () => {
    mocks.recordVoteByOptionText.mockResolvedValue({ ok: false, reason: 'already_voted' });

    await inboxProcessingService.processInboxActivity(voteActivity('Blue'), ACTOR_URI);

    expect(mocks.recordVoteByOptionText).toHaveBeenCalledWith(POLL_ID, 'Blue', VOTER_OXY_ID);
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('consumes a vote after the poll has closed (service reports poll_ended)', async () => {
    mocks.recordVoteByOptionText.mockResolvedValue({ ok: false, reason: 'poll_ended' });

    await inboxProcessingService.processInboxActivity(voteActivity('Blue'), ACTOR_URI);

    expect(mocks.recordVoteByOptionText).toHaveBeenCalledTimes(1);
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
  });

  it('drops the vote (no recording, no actor resolution) when the poll owner has sharing disabled', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(voteActivity('Blue'), ACTOR_URI);

    expect(mocks.resolveActorOxyUserId).not.toHaveBeenCalled();
    expect(mocks.recordVoteByOptionText).not.toHaveBeenCalled();
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
  });

  it('skips the vote when the remote voter cannot be resolved to an Oxy user', async () => {
    mocks.resolveActorOxyUserId.mockResolvedValue(null);

    await inboxProcessingService.processInboxActivity(voteActivity('Blue'), ACTOR_URI);

    expect(mocks.recordVoteByOptionText).not.toHaveBeenCalled();
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
  });
});

describe('handlePollVote — non-vote Creates fall through unchanged', () => {
  it('does not treat a normal reply (has content, no name) as a vote — reaches the follower gate', async () => {
    const reply = {
      id: `${ACTOR_URI}/statuses/900/activity`,
      type: 'Create' as const,
      actor: ACTOR_URI,
      object: {
        id: `${ACTOR_URI}/statuses/900`,
        type: 'Note' as const,
        attributedTo: ACTOR_URI,
        content: '<p>nice poll</p>',
        inReplyTo: TARGET_POST_URI,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
      },
    };

    await inboxProcessingService.processInboxActivity(reply, ACTOR_URI);

    expect(mocks.recordVoteByOptionText).not.toHaveBeenCalled();
    // Fell through to normal handling: the follower gate was consulted.
    expect(mocks.followExists).toHaveBeenCalledTimes(1);
  });

  it('does not treat a named reply to a NON-poll post as a vote', async () => {
    stubPostFindOne({ pollId: null }); // the referenced post carries no poll

    await inboxProcessingService.processInboxActivity(voteActivity('Blue'), ACTOR_URI);

    expect(mocks.recordVoteByOptionText).not.toHaveBeenCalled();
    expect(mocks.followExists).toHaveBeenCalledTimes(1);
  });
});
