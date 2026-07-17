import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * atproto feed-generator mirroring into NATIVE `FeedGenerator` records.
 *
 *  - `mapGeneratorView`: `app.bsky.feed.getActorFeeds` generatorView → normalized
 *    FeedGenerator fields (service DID, name, description, avatar, like count),
 *    rejecting non-generator URIs and clamping over-long name/description.
 *  - `syncActorFeeds`: getActorFeeds → upsert each generator on its AT-URI as an
 *    atproto-backed FeedGenerator. The XRPC fetch and the FeedGenerator model are
 *    mocked.
 */

const mocks = vi.hoisted(() => ({
  xrpcGet: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

vi.mock('../../../connectors/atproto/xrpcClient', () => ({ xrpcGet: mocks.xrpcGet }));

vi.mock('../../../models/FeedGenerator', () => ({
  FeedGenerator: { findOneAndUpdate: mocks.findOneAndUpdate },
}));

import { mapGeneratorView, syncActorFeeds } from '../../../connectors/atproto/feedgen.mapper';

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
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOneAndUpdate.mockResolvedValue({ _id: 'feed-doc' });
});

describe('mapGeneratorView', () => {
  it('maps a generator view to the normalized FeedGenerator fields', () => {
    const generator = mapGeneratorView(generatorView('t-videogames', { avatar: 'https://cdn/a.jpg' }));
    expect(generator).toEqual({
      uri: genUri('t-videogames'),
      serviceDid: 'did:web:feeds.example.com',
      name: 'Cool Feed',
      description: 'A nice feed',
      avatar: 'https://cdn/a.jpg',
      likeCount: 42,
    });
  });

  it('clamps an over-long name and description to the schema caps', () => {
    const generator = mapGeneratorView(
      generatorView('long', { displayName: 'n'.repeat(200), description: 'd'.repeat(500) }),
    );
    expect(generator?.name).toHaveLength(64);
    expect(generator?.description).toHaveLength(300);
  });

  it('rejects a non-generator URI, a missing service DID, and a missing name', () => {
    expect(mapGeneratorView({ uri: `at://${CREATOR_DID}/app.bsky.feed.post/x`, did: 'did:web:x', displayName: 'n' })).toBeNull();
    expect(mapGeneratorView(generatorView('f', { did: undefined }))).toBeNull();
    expect(mapGeneratorView(generatorView('f', { displayName: '   ' }))).toBeNull();
    expect(mapGeneratorView(undefined)).toBeNull();
  });
});

describe('syncActorFeeds', () => {
  it('upserts each generator on its AT-URI as an atproto-backed FeedGenerator', async () => {
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
      name: 'Cool Feed',
      description: 'A nice feed',
      algorithm: 'atproto',
      createdBy: OWNER,
      likeCount: 42,
      source: { network: 'atproto', serviceDid: 'did:web:feeds.example.com' },
    });
    expect(update.$set.source.syncedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — a re-sync upserts on the SAME AT-URI key (never duplicates)', async () => {
    mocks.xrpcGet.mockResolvedValue({ feeds: [generatorView('f1')] });

    await syncActorFeeds(CREATOR_DID, OWNER);
    await syncActorFeeds(CREATOR_DID, OWNER);

    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(2);
    for (const call of mocks.findOneAndUpdate.mock.calls) {
      expect(call[0]).toEqual({ uri: genUri('f1') });
      expect(call[2]).toEqual({ upsert: true });
    }
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
