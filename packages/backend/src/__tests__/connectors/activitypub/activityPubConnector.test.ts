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
}));

vi.mock('../../../connectors/activitypub/actor.service', () => ({
  actorService: {
    getOrFetchActor: mocks.getOrFetchActor,
    resolveWebFinger: vi.fn(),
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
  followService: {},
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
