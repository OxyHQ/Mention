import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AtprotoConnector contract: subject matching, the follow → local subscription
 * (`direction:'outbound', status:'accepted', network:'atproto'`) + backfill, and
 * the no-orphan guard on `fetchPosts`. All network + persistence collaborators
 * are mocked.
 */

const mocks = vi.hoisted(() => ({
  resolveIdentity: vi.fn(),
  fetchAndUpsertAtprotoProfile: vi.fn(),
  importAuthorFeed: vi.fn(),
  resolveOxyExternalUser: vi.fn(),
  followUpsert: vi.fn(),
  followDelete: vi.fn(),
}));

vi.mock('../../../connectors/atproto/identityResolver', () => ({
  resolveIdentity: mocks.resolveIdentity,
}));

vi.mock('../../../connectors/atproto/profile.mapper', () => ({
  fetchAndUpsertAtprotoProfile: mocks.fetchAndUpsertAtprotoProfile,
}));

vi.mock('../../../connectors/atproto/post.mapper', () => ({
  importAuthorFeed: mocks.importAuthorFeed,
}));

vi.mock('../../../connectors/identity', () => ({
  resolveOxyExternalUser: mocks.resolveOxyExternalUser,
}));

vi.mock('../../../models/FederatedFollow', () => ({
  default: {
    findOneAndUpdate: mocks.followUpsert,
    deleteOne: mocks.followDelete,
  },
}));

import { atprotoConnector } from '../../../connectors/atproto/AtprotoConnector';

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveIdentity.mockResolvedValue({ did: DID, handle: 'alice.bsky.social' });
  mocks.fetchAndUpsertAtprotoProfile.mockResolvedValue({
    network: 'atproto',
    externalId: DID,
    handle: 'alice.bsky.social',
    oxyUserId: 'oxy-alice',
  });
  mocks.importAuthorFeed.mockResolvedValue({ posts: [], cursor: undefined });
  mocks.followUpsert.mockResolvedValue({ _id: 'ff1' });
  mocks.followDelete.mockResolvedValue({ deletedCount: 1 });
});

describe('AtprotoConnector.matches', () => {
  it('claims DIDs, AT-URIs and bare handles, never fediverse accts or URLs', () => {
    expect(atprotoConnector.matches(DID)).toBe(true);
    expect(atprotoConnector.matches('at://did:plc:x/app.bsky.feed.post/y')).toBe(true);
    expect(atprotoConnector.matches('alice.bsky.social')).toBe(true);
    expect(atprotoConnector.matches('@alice@mastodon.social')).toBe(false);
    expect(atprotoConnector.matches('https://mastodon.social/users/alice')).toBe(false);
  });
});

describe('AtprotoConnector.deliver', () => {
  it('records a local subscription on follow.add and backfills the feed', async () => {
    await atprotoConnector.deliver({
      kind: 'follow.add',
      localOxyUserId: 'viewer-1',
      localUsername: 'viewer',
      targetActorUri: DID,
    });

    expect(mocks.followUpsert).toHaveBeenCalledWith(
      { localUserId: 'viewer-1', remoteActorUri: DID, direction: 'outbound' },
      { $set: { status: 'accepted', network: 'atproto' } },
      expect.objectContaining({ upsert: true }),
    );
    expect(mocks.importAuthorFeed).toHaveBeenCalled();
  });

  it('removes the local subscription on follow.remove', async () => {
    await atprotoConnector.deliver({
      kind: 'follow.remove',
      localOxyUserId: 'viewer-1',
      localUsername: 'viewer',
      targetActorUri: DID,
    });

    expect(mocks.followDelete).toHaveBeenCalledWith({
      localUserId: 'viewer-1',
      remoteActorUri: DID,
      direction: 'outbound',
    });
  });

  it('is a no-op on post.create (no outbound publish in C2)', async () => {
    await expect(
      atprotoConnector.deliver({
        kind: 'post.create',
        post: { _id: 'p1', content: { text: 'hi' }, visibility: 'public', createdAt: '2024-01-01T00:00:00.000Z' },
        actorOxyUserId: 'viewer-1',
        actorUsername: 'viewer',
      }),
    ).resolves.toBeUndefined();
    expect(mocks.followUpsert).not.toHaveBeenCalled();
  });
});

describe('AtprotoConnector.fetchPosts', () => {
  it('skips the backfill (no orphan) when the actor has no resolved Oxy user', async () => {
    mocks.fetchAndUpsertAtprotoProfile.mockResolvedValue({
      network: 'atproto',
      externalId: DID,
      handle: 'alice.bsky.social',
      oxyUserId: undefined,
    });

    const result = await atprotoConnector.fetchPosts(DID);

    expect(result).toEqual({ posts: [] });
    expect(mocks.importAuthorFeed).not.toHaveBeenCalled();
  });
});
