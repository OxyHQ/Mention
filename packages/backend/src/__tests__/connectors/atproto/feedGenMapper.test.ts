import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * atproto feed-generator mirroring (READ-ONLY references).
 *
 *  - `mapGeneratorToExternalFeed`: `app.bsky.feed.getActorFeeds` generatorView →
 *    normalized external-feed reference (service DID, name, description, avatar,
 *    like count, bsky.app deep link), rejecting non-generator URIs.
 *  - `syncActorFeeds`: getActorFeeds → upsert each reference on its AT-URI. The
 *    XRPC fetch and the ExternalFeed model are mocked.
 */

const mocks = vi.hoisted(() => ({
  xrpcGet: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

vi.mock('../../../connectors/atproto/xrpcClient', () => ({ xrpcGet: mocks.xrpcGet }));

vi.mock('../../../models/ExternalFeed', () => ({
  default: { findOneAndUpdate: mocks.findOneAndUpdate },
}));

import { mapGeneratorToExternalFeed, syncActorFeeds } from '../../../connectors/atproto/feedgen.mapper';

const CREATOR_DID = 'did:plc:creator0000000000000000';
const OWNER = 'oxy-creator';

function genUri(rkey: string): string {
  return `at://${CREATOR_DID}/app.bsky.feed.generator/${rkey}`;
}

function generatorView(rkey: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uri: genUri(rkey),
    did: 'did:web:feeds.example.com',
    displayName: 'Cool Feed',
    description: 'A nice feed',
    likeCount: 42,
    creator: { did: CREATOR_DID, handle: 'creator.bsky.social' },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOneAndUpdate.mockResolvedValue({ _id: 'feed-doc' });
});

describe('mapGeneratorToExternalFeed', () => {
  it('maps a generator view to a read-only reference with a handle-based deep link', () => {
    const feed = mapGeneratorToExternalFeed(generatorView('t-videogames'));
    expect(feed).toEqual({
      uri: genUri('t-videogames'),
      serviceDid: 'did:web:feeds.example.com',
      name: 'Cool Feed',
      description: 'A nice feed',
      avatar: undefined,
      likeCount: 42,
      webUrl: 'https://bsky.app/profile/creator.bsky.social/feed/t-videogames',
    });
  });

  it('falls back to the creator DID for the deep link when no handle is present', () => {
    const feed = mapGeneratorToExternalFeed(generatorView('f1', { creator: { did: CREATOR_DID } }));
    expect(feed?.webUrl).toBe(`https://bsky.app/profile/${CREATOR_DID}/feed/f1`);
  });

  it('rejects a non-generator URI, a missing service DID, and a missing name', () => {
    expect(mapGeneratorToExternalFeed({ uri: `at://${CREATOR_DID}/app.bsky.feed.post/x`, did: 'did:web:x', displayName: 'n' })).toBeNull();
    expect(mapGeneratorToExternalFeed(generatorView('f', { did: undefined }))).toBeNull();
    expect(mapGeneratorToExternalFeed(generatorView('f', { displayName: '   ' }))).toBeNull();
    expect(mapGeneratorToExternalFeed(undefined)).toBeNull();
  });
});

describe('syncActorFeeds', () => {
  it('upserts each feed reference on its AT-URI', async () => {
    mocks.xrpcGet.mockResolvedValue({
      feeds: [generatorView('f1'), generatorView('f2', { displayName: 'Second', avatar: 'https://cdn/a.jpg' })],
    });

    const count = await syncActorFeeds(CREATOR_DID, OWNER);

    expect(count).toBe(2);
    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(2);
    const [filter, update, options] = mocks.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ uri: genUri('f1') });
    expect(options).toEqual({ upsert: true });
    expect(update.$set).toMatchObject({
      network: 'atproto',
      ownerOxyUserId: OWNER,
      serviceDid: 'did:web:feeds.example.com',
      name: 'Cool Feed',
      webUrl: 'https://bsky.app/profile/creator.bsky.social/feed/f1',
    });
    expect(update.$set.syncedAt).toBeInstanceOf(Date);
  });

  it('skips unmappable generator views', async () => {
    mocks.xrpcGet.mockResolvedValue({
      feeds: [generatorView('ok'), { uri: 'not-an-at-uri', displayName: 'x', did: 'did:web:y' }],
    });
    const count = await syncActorFeeds(CREATOR_DID, OWNER);
    expect(count).toBe(1);
    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('no-ops without a resolved Oxy owner and fails soft on a fetch error', async () => {
    expect(await syncActorFeeds(CREATOR_DID, '')).toBe(0);
    expect(mocks.xrpcGet).not.toHaveBeenCalled();

    mocks.xrpcGet.mockRejectedValue(new Error('boom'));
    expect(await syncActorFeeds(CREATOR_DID, OWNER)).toBe(0);
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
