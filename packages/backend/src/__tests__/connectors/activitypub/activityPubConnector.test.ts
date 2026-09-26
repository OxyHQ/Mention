import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ActivityPubConnector.fetchPosts must forward the incoming opaque cursor as
 * `startPageUrl` to `outboxSyncService.syncOutboxPostsDetailed`, so pagination
 * advances instead of re-fetching the first page every call. The returned cursor
 * is `result.nextCursor?.url`.
 */

const mocks = vi.hoisted(() => ({
  getOrFetchActor: vi.fn(),
  syncOutboxPostsDetailed: vi.fn(),
  federateLike: vi.fn(),
  federateLikeStrict: vi.fn(),
  federateUndoLike: vi.fn(),
  federateUndoLikeStrict: vi.fn(),
  resolveWebFinger: vi.fn(),
  sendFollow: vi.fn(),
  sendUndoFollow: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/actor.service', () => ({
  actorService: {
    getOrFetchActor: mocks.getOrFetchActor,
    resolveWebFinger: mocks.resolveWebFinger,
    fetchRemoteActor: vi.fn(),
    refreshActorInBackground: vi.fn(),
    fetchPublicKey: vi.fn(),
  },
}));

vi.mock('../../../connectors/activitypub/outbox.service', () => ({
  outboxSyncService: {
    syncOutboxPostsDetailed: mocks.syncOutboxPostsDetailed,
    syncOutboxPosts: vi.fn(),
    markOutboxBackfillUnavailable: vi.fn(),
  },
  // Runtime values re-exported by ActivityPubConnector at module eval.
  isPermanentlyUnavailableOutboxReason: vi.fn().mockReturnValue(false),
  PERMANENTLY_UNAVAILABLE_OUTBOX_REASONS: [],
}));

vi.mock('../../../connectors/activitypub/follow.service', () => ({
  followService: {
    federateLike: mocks.federateLike,
    federateLikeStrict: mocks.federateLikeStrict,
    federateUndoLike: mocks.federateUndoLike,
    federateUndoLikeStrict: mocks.federateUndoLikeStrict,
  },
}));

vi.mock('../../../connectors/activitypub/delivery.service', () => ({
  deliveryService: {
    sendFollow: mocks.sendFollow,
    sendUndoFollow: mocks.sendUndoFollow,
  },
}));

vi.mock('../../../connectors/activitypub/inbox.service', () => ({
  inboxProcessingService: { processInboxActivity: vi.fn() },
}));

vi.mock('../../../connectors/identity', () => ({
  resolveOxyExternalUser: vi.fn(),
}));

import { activityPubConnector } from '../../../connectors/activitypub/ActivityPubConnector';

const ACTOR_URI = 'https://mastodon.social/users/alice';
const OUTBOX_URL = 'https://mastodon.social/users/alice/outbox';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrFetchActor.mockResolvedValue({ uri: ACTOR_URI, acct: 'alice@mastodon.social', outboxUrl: OUTBOX_URL });
  mocks.syncOutboxPostsDetailed.mockResolvedValue({
    syncedCount: 20,
    shouldStampCooldown: false,
    nextCursor: { url: `${OUTBOX_URL}?page=2`, itemOffset: 0 },
  });
});

describe('ActivityPubConnector.fetchPosts', () => {
  it('forwards the incoming cursor as startPageUrl and returns the next cursor url', async () => {
    const result = await activityPubConnector.fetchPosts(ACTOR_URI, {
      limit: 30,
      cursor: `${OUTBOX_URL}?page=1`,
    });

    expect(mocks.syncOutboxPostsDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ outboxUrl: OUTBOX_URL }),
      { limit: 30, startPageUrl: `${OUTBOX_URL}?page=1` },
    );
    expect(result).toEqual({ posts: [], cursor: `${OUTBOX_URL}?page=2` });
  });

  it('passes startPageUrl: undefined (first page) when no cursor is supplied', async () => {
    await activityPubConnector.fetchPosts(ACTOR_URI);

    expect(mocks.syncOutboxPostsDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ outboxUrl: OUTBOX_URL }),
      { limit: 20, startPageUrl: undefined },
    );
  });

  it('returns no posts and never syncs when the actor has no outbox URL', async () => {
    mocks.getOrFetchActor.mockResolvedValue({ uri: ACTOR_URI, acct: 'alice@mastodon.social' });

    const result = await activityPubConnector.fetchPosts(ACTOR_URI, { cursor: 'x' });

    expect(result).toEqual({ posts: [] });
    expect(mocks.syncOutboxPostsDetailed).not.toHaveBeenCalled();
  });
});

describe('ActivityPubConnector durable delivery boundary', () => {
  const likeEvent = {
    kind: 'post.like' as const,
    like: { _id: 'like-1', postId: 'post-1' },
    actorOxyUserId: 'viewer-1',
    actorUsername: 'alice',
  };

  it('keeps ordinary delivery on the best-effort FollowService method', async () => {
    await activityPubConnector.deliver(likeEvent);

    expect(mocks.federateLike).toHaveBeenCalledWith(
      likeEvent.like,
      'viewer-1',
      'alice',
    );
    expect(mocks.federateLikeStrict).not.toHaveBeenCalled();
  });

  it('uses the strict FollowService method and propagates its rejection', async () => {
    mocks.federateLikeStrict.mockRejectedValueOnce(
      new Error('delivery queue unavailable'),
    );

    await expect(
      activityPubConnector.deliverDurably(likeEvent),
    ).rejects.toThrow('delivery queue unavailable');

    expect(mocks.federateLikeStrict).toHaveBeenCalledWith(
      likeEvent.like,
      'viewer-1',
      'alice',
    );
    expect(mocks.federateLike).not.toHaveBeenCalled();
  });

  it('uses the strict Undo method for durable unlikes', async () => {
    const unlikeEvent = { ...likeEvent, kind: 'post.unlike' as const };

    await activityPubConnector.deliverDurably(unlikeEvent);

    expect(mocks.federateUndoLikeStrict).toHaveBeenCalledWith(
      unlikeEvent.like,
      'viewer-1',
      'alice',
    );
    expect(mocks.federateUndoLike).not.toHaveBeenCalled();
  });
});

describe('ActivityPubConnector follow delivery', () => {
  const NUMERIC_ACTOR_URI = 'https://mastodon.social/ap/users/116807053288112257';
  const follow = (targetActorUri: string) => ({
    kind: 'follow.add' as const,
    localOxyUserId: 'local-1',
    localUsername: 'mention',
    targetActorUri,
  });

  beforeEach(() => {
    mocks.sendFollow.mockResolvedValue({ success: true, pending: false });
    mocks.sendUndoFollow.mockResolvedValue(true);
  });

  it('resolves a handle to its actor by WebFinger before sending the Follow', async () => {
    mocks.resolveWebFinger.mockResolvedValue(NUMERIC_ACTOR_URI);

    await activityPubConnector.deliver(follow('@Alice@mastodon.social'));

    expect(mocks.resolveWebFinger).toHaveBeenCalledWith('alice@mastodon.social');
    expect(mocks.sendFollow).toHaveBeenCalledWith('local-1', 'mention', NUMERIC_ACTOR_URI);
  });

  it('sends a Follow addressed by actor URI as is, with no WebFinger', async () => {
    await activityPubConnector.deliver(follow(ACTOR_URI));

    expect(mocks.resolveWebFinger).not.toHaveBeenCalled();
    expect(mocks.sendFollow).toHaveBeenCalledWith('local-1', 'mention', ACTOR_URI);
  });

  it('rejects a handle that does not resolve, sending nothing', async () => {
    mocks.resolveWebFinger.mockResolvedValue(null);

    await expect(activityPubConnector.deliver(follow('nobody@mastodon.social'))).rejects.toThrow(
      'Fediverse handle did not resolve',
    );
    expect(mocks.sendFollow).not.toHaveBeenCalled();
  });

  it('rejects a Follow the delivery engine refused, instead of reporting it followed', async () => {
    mocks.sendFollow.mockResolvedValue({ success: false, pending: false });

    await expect(activityPubConnector.deliver(follow(ACTOR_URI))).rejects.toThrow('Follow was not sent');
  });

  it('resolves a handle before sending the Undo(Follow)', async () => {
    mocks.resolveWebFinger.mockResolvedValue(NUMERIC_ACTOR_URI);

    await activityPubConnector.deliver({ ...follow('alice@mastodon.social'), kind: 'follow.remove' });

    expect(mocks.sendUndoFollow).toHaveBeenCalledWith('local-1', 'mention', NUMERIC_ACTOR_URI);
  });
});
