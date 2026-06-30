import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * atproto post mapping + import.
 *
 *  - `mapPostViewToNormalizedPost`: `app.bsky.feed.post` PostView → normalized
 *    post (AT-URI provenance, bsky.app web URL, reply parent, embed media,
 *    richtext hashtags, langs, adult self-labels), with the actor-match guard.
 *  - `importAuthorFeed`: getAuthorFeed → dedup on the AT-URI → import the new
 *    posts via `getPostCreator().create`, skipping reposts. The XRPC fetch, the
 *    Post model, the post creator, and media materialization are mocked.
 */

const mocks = vi.hoisted(() => ({
  xrpcGet: vi.fn(),
  postFind: vi.fn(),
  create: vi.fn(),
  materialize: vi.fn(),
}));

vi.mock('../../../connectors/atproto/xrpcClient', () => ({ xrpcGet: mocks.xrpcGet }));

vi.mock('../../../models/Post', () => ({
  POST_CLASSIFICATION_PENDING: 'pending',
  Post: { find: mocks.postFind },
}));

vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.create }),
  registerPostCreator: vi.fn(),
  registerPostFederator: vi.fn(),
  getPostFederator: vi.fn(),
}));

vi.mock('../../../connectors/shared/federatedMedia', () => ({
  materializeFederatedMedia: mocks.materialize,
}));

import {
  importAuthorFeed,
  mapPostViewToNormalizedPost,
} from '../../../connectors/atproto/post.mapper';
import type { NormalizedExternalActor } from '../../../connectors/types';

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';

function atUri(rkey: string): string {
  return `at://${DID}/app.bsky.feed.post/${rkey}`;
}

function postView(rkey: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uri: atUri(rkey),
    cid: 'cid',
    author: { did: DID, handle: 'alice.bsky.social' },
    record: {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: '2024-01-01T00:00:00.000Z',
      ...(extra.record as Record<string, unknown> | undefined),
    },
    embed: extra.embed,
    indexedAt: '2024-01-01T00:00:00.000Z',
  };
}

const ACTOR: NormalizedExternalActor = {
  network: 'atproto',
  externalId: DID,
  handle: 'alice.bsky.social',
  oxyUserId: 'oxy-alice',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.postFind.mockReturnValue({ select: () => ({ lean: async () => [] }) });
  mocks.create.mockResolvedValue({ _id: 'created1' });
  mocks.materialize.mockImplementation(async (media: unknown, attachments: unknown) => ({ media, attachments }));
});

describe('mapPostViewToNormalizedPost', () => {
  it('maps a feed post to the normalized provenance shape', () => {
    const post = mapPostViewToNormalizedPost(postView('abc', 'hello bluesky'), DID);

    expect(post).toMatchObject({
      network: 'atproto',
      activityId: atUri('abc'),
      actorUri: DID,
      url: 'https://bsky.app/profile/alice.bsky.social/post/abc',
      text: 'hello bluesky',
    });
  });

  it('extracts reply parent, langs, hashtags, image media and adult labels', () => {
    const post = mapPostViewToNormalizedPost(
      postView('rich', 'tagged', {
        record: {
          $type: 'app.bsky.feed.post',
          text: 'tagged',
          createdAt: '2024-01-01T00:00:00.000Z',
          reply: { parent: { uri: 'at://did:plc:other/app.bsky.feed.post/parent' } },
          langs: ['en-US', 'es'],
          tags: ['atproto'],
          facets: [{ features: [{ $type: 'app.bsky.richtext.facet#tag', tag: '#bluesky' }] }],
          labels: { values: [{ val: 'porn' }] },
        },
        embed: {
          $type: 'app.bsky.embed.images#view',
          images: [{ thumb: 'https://cdn/thumb.jpg', fullsize: 'https://cdn/full.jpg', alt: 'a' }],
        },
      }),
      DID,
    );

    expect(post?.inReplyTo).toBe('at://did:plc:other/app.bsky.feed.post/parent');
    expect(post?.language).toBe('en');
    expect(post?.languages).toEqual(['en', 'es']);
    expect(post?.hashtags).toEqual(expect.arrayContaining(['atproto', 'bluesky']));
    expect(post?.sensitive).toBe(true);
    expect(post?.media).toEqual([{ id: 'https://cdn/full.jpg', type: 'image', remoteUrl: 'https://cdn/full.jpg' }]);
  });

  it('extracts video playlist media from a video embed view', () => {
    const post = mapPostViewToNormalizedPost(
      postView('vid', 'a video', {
        embed: { $type: 'app.bsky.embed.video#view', playlist: 'https://cdn/playlist.m3u8', thumbnail: 'https://cdn/thumb.jpg' },
      }),
      DID,
    );
    expect(post?.media).toEqual([{ id: 'https://cdn/playlist.m3u8', type: 'video', remoteUrl: 'https://cdn/playlist.m3u8' }]);
  });

  it('rejects a non-feed-post record, a wrong author, and a non-AT-URI', () => {
    // Wrong collection (a like, not a post).
    expect(
      mapPostViewToNormalizedPost(
        { uri: `at://${DID}/app.bsky.feed.like/x`, author: { did: DID }, record: { $type: 'app.bsky.feed.like' } },
        DID,
      ),
    ).toBeNull();
    // Author does not match the synced actor.
    expect(mapPostViewToNormalizedPost(postView('x', 'forged'), 'did:plc:someoneelse000000000000')).toBeNull();
    // Not an AT-URI.
    expect(mapPostViewToNormalizedPost({ uri: 'https://bsky.app/x', author: { did: DID } }, DID)).toBeNull();
  });
});

describe('importAuthorFeed', () => {
  it('imports new posts, dedups on the AT-URI, and skips reposts', async () => {
    mocks.xrpcGet.mockResolvedValue({
      cursor: 'next-cursor',
      feed: [
        { post: postView('a', 'fresh post') },
        // A repost carries a `reason` — skipped in C2.
        { post: postView('b', 'reposted'), reason: { $type: 'app.bsky.feed.defs#reasonRepost' } },
        // Already imported (returned by the dedup query) — skipped.
        { post: postView('c', 'already here') },
      ],
    });
    mocks.postFind.mockReturnValue({
      select: () => ({ lean: async () => [{ federation: { activityId: atUri('c') } }] }),
    });

    const result = await importAuthorFeed(ACTOR);

    expect(result.cursor).toBe('next-cursor');
    expect(result.posts.map((p) => p.activityId)).toEqual([atUri('a')]);
    // Exactly one create (post 'a'); 'b' skipped (repost), 'c' skipped (dedup).
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        oxyUserId: 'oxy-alice',
        federation: expect.objectContaining({ activityId: atUri('a'), actorUri: DID }),
        visibility: 'public',
        skipNotifications: true,
        skipSocketEmit: true,
        skipFederationDelivery: true,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      }),
    );
    // Media materialization ran for the imported post.
    expect(mocks.materialize).toHaveBeenCalledTimes(1);
  });

  it('returns empty without creating when the actor has no resolved Oxy user', async () => {
    const result = await importAuthorFeed({ ...ACTOR, oxyUserId: undefined });
    expect(result.posts).toEqual([]);
    expect(mocks.xrpcGet).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
