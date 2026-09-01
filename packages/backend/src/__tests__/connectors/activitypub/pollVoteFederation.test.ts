import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedFollow,
  seedPost,
} from '../../helpers/federationFixtures';

const scope = federationScope('poll-vote-federation');

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
 * Drives the REAL `InboxProcessingService`; only `pollVoteService` and the actor
 * resolver are stubbed (same convention as the sibling `inboundSharingGates.test.ts`).
 *
 * The POST is real. Batch 7 moved `resolvePostIdFromObjectUri` and
 * `loadPostRecord` to Postgres, so the `Post.find` mock this suite carried stopped
 * intercepting anything: every vote resolved to no post, `handlePollVote` returned
 * false at its first DB gate, and the three positive cases recorded nothing. The
 * four "is not recorded" cases kept passing throughout — which is the tell, since
 * a path that never runs satisfies every not-called assertion at once.
 *
 * A real row also makes the poll gate real: what separates "a vote" from "a named
 * reply to an ordinary post" is now `posts.content_poll_id` on the target, not a
 * projection branch in a mock.
 *
 * The FOLLOW rows are real too, so "a vote never reaches the follower gate" is
 * observed through the gate's own effect: with no follow seeded the fall-through
 * path drops the activity, and with one seeded it ingests — a vote does neither.
 */

const ACTOR_URI = `${scope.origin}/users/bob`;
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
 * Insert the LOCAL post the vote replies to.
 *
 * `id` is pinned because `TARGET_POST_URI` embeds it — `resolvePostIdFromObjectUri`
 * parses the id straight out of the AP URI, so the row and the activity have to
 * agree. `pollId: null` writes the same post WITHOUT a poll, which is the whole
 * difference between a vote and a named reply.
 */
async function seedTargetPost(overrides: { pollId?: string | null } = {}) {
  const { pollId = POLL_ID } = overrides;
  return seedPost(scope, {
    id: TARGET_POST_ID,
    oxyUserId: OWNER_OXY_ID,
    authorship: [{ oxyUserId: OWNER_OXY_ID, role: 'owner', status: 'accepted' }],
    content: {
      variants: [{ source: 'author', text: 'Favourite colour?', tag: 'en' }],
      ...(pollId ? { pollId } : {}),
    },
  });
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFederationScope(scope);
  mocks.resolveActorOxyUserId.mockResolvedValue(VOTER_OXY_ID);
  mocks.recordVoteByOptionText.mockResolvedValue({ ok: true, poll: { _id: POLL_ID } });
  mocks.isFediverseSharingEnabled.mockResolvedValue(true);
  mocks.postCreatorCreate.mockResolvedValue({ _id: 'created_post_1' });
  mocks.ensureFederatedReplyLink.mockResolvedValue({ parentPostId: TARGET_POST_ID, threadId: TARGET_POST_ID });
});

describe('handlePollVote — recording a remote vote on a local poll', () => {
  it('resolves the voter and records the vote by option name; the Create is consumed (no reply post)', async () => {
    await seedTargetPost();

    await inboxProcessingService.processInboxActivity(voteActivity('Blue'), ACTOR_URI);

    expect(mocks.isFediverseSharingEnabled).toHaveBeenCalledWith(OWNER_OXY_ID);
    expect(mocks.resolveActorOxyUserId).toHaveBeenCalledWith(ACTOR_URI);
    expect(mocks.recordVoteByOptionText).toHaveBeenCalledWith(POLL_ID, 'Blue', VOTER_OXY_ID);
    // A vote is never materialized as a reply post.
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
  });

  it('consumes a duplicate vote without error and without creating a post', async () => {
    await seedTargetPost();
    mocks.recordVoteByOptionText.mockResolvedValue({ ok: false, reason: 'already_voted' });

    await inboxProcessingService.processInboxActivity(voteActivity('Blue'), ACTOR_URI);

    expect(mocks.recordVoteByOptionText).toHaveBeenCalledWith(POLL_ID, 'Blue', VOTER_OXY_ID);
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('consumes a vote after the poll has closed (service reports poll_ended)', async () => {
    await seedTargetPost();
    mocks.recordVoteByOptionText.mockResolvedValue({ ok: false, reason: 'poll_ended' });

    await inboxProcessingService.processInboxActivity(voteActivity('Blue'), ACTOR_URI);

    expect(mocks.recordVoteByOptionText).toHaveBeenCalledTimes(1);
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
  });

  it('drops the vote (no recording, no actor resolution) when the poll owner has sharing disabled', async () => {
    await seedTargetPost();
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(voteActivity('Blue'), ACTOR_URI);

    expect(mocks.resolveActorOxyUserId).not.toHaveBeenCalled();
    expect(mocks.recordVoteByOptionText).not.toHaveBeenCalled();
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
  });

  it('skips the vote when the remote voter cannot be resolved to an Oxy user', async () => {
    await seedTargetPost();
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

    // The actor IS followed AND resolved, so falling through to normal handling
    // reaches the post-ingest path rather than being dropped by the follower gate
    // or deferred by the mandatory-Oxy-link invariant. That is what makes "fell
    // through" observable now that both are real queries.
    await seedTargetPost();
    await seedActor(scope, {
      username: 'bob',
      uri: ACTOR_URI,
      oxyUserId: VOTER_OXY_ID,
      lastFetchedAt: new Date(),
    });
    await seedFollow(scope, { remoteActorUri: ACTOR_URI, direction: 'outbound', status: 'accepted' });
    // The actor RESOLVER is stubbed in this suite (it is not what is under test),
    // so the ingest path's mandatory-Oxy-link lookup goes through it too.
    mocks.getOrFetchActor.mockResolvedValue({ uri: ACTOR_URI, oxyUserId: VOTER_OXY_ID });

    await inboxProcessingService.processInboxActivity(reply, ACTOR_URI);

    expect(mocks.recordVoteByOptionText).not.toHaveBeenCalled();
    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
  });

  it('does not treat a named reply to a NON-poll post as a vote', async () => {
    await seedTargetPost({ pollId: null }); // the referenced post carries no poll

    await inboxProcessingService.processInboxActivity(voteActivity('Blue'), ACTOR_URI);

    expect(mocks.recordVoteByOptionText).not.toHaveBeenCalled();
  });
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});
