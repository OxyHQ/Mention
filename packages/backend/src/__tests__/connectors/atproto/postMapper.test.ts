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
  federatedActorFindOne: vi.fn(),
  fetchProfile: vi.fn(),
}));

vi.mock('../../../connectors/atproto/xrpcClient', () => ({ xrpcGet: mocks.xrpcGet }));

vi.mock('../../../models/Post', () => ({
  POST_CLASSIFICATION_PENDING: 'pending',
  Post: { find: mocks.postFind },
}));

vi.mock('../../../models/FederatedActor', () => ({
  default: { findOne: mocks.federatedActorFindOne },
}));

// Mention resolution goes through the atproto profile path; mocked so the mapper's
// mention/quote/reply resolution never reaches the heavy identity chain.
vi.mock('../../../connectors/atproto/profile.mapper', () => ({
  fetchAndUpsertAtprotoProfile: mocks.fetchProfile,
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
  importPostViews,
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
  federatedUsername: 'alice.bsky.social@bsky.social',
  instanceDomain: 'bsky.social',
  oxyUserId: 'oxy-alice',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.postFind.mockReturnValue({ select: () => ({ lean: async () => [] }) });
  mocks.create.mockResolvedValue({ _id: 'created1' });
  mocks.materialize.mockImplementation(async (media: unknown, attachments: unknown) => ({ media, attachments }));
  mocks.federatedActorFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
  mocks.fetchProfile.mockResolvedValue(null);
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
    expect(post?.media).toEqual([{ id: 'https://cdn/full.jpg', type: 'image', remoteUrl: 'https://cdn/full.jpg', alt: 'a' }]);
  });

  it('normalizes the whitespace of the post body, keeping the author’s paragraphs', () => {
    // Bluesky text is third-party text and used to be stored with zero trimming.
    // The author's blank line survives; the trailing spaces and the extra blank
    // lines do not (the client renders them verbatim).
    const post = mapPostViewToNormalizedPost(postView('ws', '  uno   \r\n\r\n\r\n\r\n  dos  '), DID);
    expect(post?.text).toBe('uno\n\ndos');
  });

  it('normalizes image alt text to a single line', () => {
    const post = mapPostViewToNormalizedPost(
      postView('alt', 'con imagen', {
        embed: {
          $type: 'app.bsky.embed.images#view',
          images: [
            { fullsize: 'https://cdn/full.jpg', alt: '  un gato\n  en una caja  ' },
            { fullsize: 'https://cdn/blank.jpg', alt: '   \n  ' },
          ],
        },
      }),
      DID,
    );

    expect(post?.media?.[0].alt).toBe('un gato en una caja');
    // A whitespace-only alt is not alt text: the field is omitted.
    expect(post?.media?.[1].alt).toBeUndefined();
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

  it('replaces a #link facet display text with the full URL (byte-indexed)', () => {
    // Bluesky stores the truncated display URL in `text` but the FULL url in the
    // facet feature — the Gothamist bug. The facet byte range covers the display.
    const text = 'Read gothamist.com/news/lo…'; // '…' is a 3-byte UTF-8 char
    const byteEnd = Buffer.byteLength(text, 'utf8');
    const post = mapPostViewToNormalizedPost(
      postView('lnk', text, {
        record: {
          facets: [
            {
              index: { byteStart: 5, byteEnd },
              features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://gothamist.com/news/long-article' }],
            },
          ],
        },
      }),
      DID,
    );
    expect(post?.text).toBe('Read https://gothamist.com/news/long-article');
  });

  it('handles multiple #link facets with a multibyte emoji before them', () => {
    // '👋' is 4 UTF-8 bytes: a JS-string (UTF-16) index would mis-target the facet.
    const text = '👋 foo.co and bar.co';
    const post = mapPostViewToNormalizedPost(
      postView('multi', text, {
        record: {
          facets: [
            {
              index: { byteStart: 5, byteEnd: 11 }, // 'foo.co'
              features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://foo.co/full' }],
            },
            {
              index: { byteStart: 16, byteEnd: 22 }, // 'bar.co'
              features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://bar.co/full' }],
            },
          ],
        },
      }),
      DID,
    );
    expect(post?.text).toBe('👋 https://foo.co/full and https://bar.co/full');
  });

  it('replaces a resolved #mention facet with a [mention:<id>] placeholder and collects it', () => {
    const MENTION_DID = 'did:plc:bob00000000000000000000';
    const post = mapPostViewToNormalizedPost(
      postView('mp', 'hi @bob.bsky.social!', {
        record: {
          facets: [
            {
              index: { byteStart: 3, byteEnd: 19 }, // '@bob.bsky.social'
              features: [{ $type: 'app.bsky.richtext.facet#mention', did: MENTION_DID }],
            },
          ],
        },
      }),
      DID,
      new Map([[MENTION_DID, 'oxy-bob']]),
    );
    expect(post?.text).toBe('hi [mention:oxy-bob]!');
    expect(post?.mentions).toEqual(['oxy-bob']);
  });

  it('leaves an unresolved #mention as bare @handle text (no placeholder, no mentions)', () => {
    const post = mapPostViewToNormalizedPost(
      postView('um', 'hi @ghost.bsky.social!', {
        record: {
          facets: [
            {
              index: { byteStart: 3, byteEnd: 21 }, // '@ghost.bsky.social'
              features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:ghost0000000000000000000' }],
            },
          ],
        },
      }),
      DID,
      new Map(), // nothing resolved
    );
    expect(post?.text).toBe('hi @ghost.bsky.social!');
    expect(post?.mentions).toBeUndefined();
  });

  it('maps an embedded record#view quote to quotedUri', () => {
    const QUOTED_URI = 'at://did:plc:q/app.bsky.feed.post/qk';
    const post = mapPostViewToNormalizedPost(
      postView('q', 'nice', {
        embed: {
          $type: 'app.bsky.embed.record#view',
          record: { $type: 'app.bsky.embed.record#viewRecord', uri: QUOTED_URI },
        },
      }),
      DID,
    );
    expect(post?.quotedUri).toBe(QUOTED_URI);
  });

  it('maps a recordWithMedia#view quote to quotedUri and keeps the media', () => {
    const QUOTED_URI = 'at://did:plc:q/app.bsky.feed.post/qk';
    const post = mapPostViewToNormalizedPost(
      postView('qm', 'nice pic', {
        embed: {
          $type: 'app.bsky.embed.recordWithMedia#view',
          record: {
            $type: 'app.bsky.embed.record#view',
            record: { $type: 'app.bsky.embed.record#viewRecord', uri: QUOTED_URI },
          },
          media: {
            $type: 'app.bsky.embed.images#view',
            images: [{ fullsize: 'https://cdn/q.jpg', alt: 'pic' }],
          },
        },
      }),
      DID,
    );
    expect(post?.quotedUri).toBe(QUOTED_URI);
    expect(post?.media).toEqual([{ id: 'https://cdn/q.jpg', type: 'image', remoteUrl: 'https://cdn/q.jpg', alt: 'pic' }]);
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
        // The imported post is stamped with the actor's INSTANCE domain
        // (`bsky.social`), not the bare full handle (`alice.bsky.social`),
        // matching the AP `Post.instanceDomain = actor host` convention.
        instanceDomain: 'bsky.social',
        skipNotifications: true,
        skipSocketEmit: true,
        skipFederationDelivery: true,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      }),
    );
    // Media materialization ran for the imported post, scoped to the resolved
    // Oxy owner — so its remote bsky CDN media mirrors into Oxy S3 (not proxied).
    expect(mocks.materialize).toHaveBeenCalledTimes(1);
    expect(mocks.materialize).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      'oxy-alice',
      expect.objectContaining({ activityId: atUri('a'), actorUri: DID }),
    );
  });

  it('returns empty without creating when the actor has no resolved Oxy user', async () => {
    const result = await importAuthorFeed({ ...ACTOR, oxyUserId: undefined });
    expect(result.posts).toEqual([]);
    expect(mocks.xrpcGet).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('stamps parentPostId + threadId when the reply parent is imported locally', async () => {
    const PARENT_URI = 'at://did:plc:parent/app.bsky.feed.post/root';
    mocks.xrpcGet.mockResolvedValue({
      feed: [{ post: postView('reply', 'a reply', { record: { reply: { parent: { uri: PARENT_URI } } } }) }],
    });
    // The dedup query selects only the activityId; the thread/quote resolver
    // selects `_id threadId federation.activityId` — branch on that to return the
    // parent for the resolver but nothing for the dedup.
    mocks.postFind.mockImplementation(() => ({
      select: (fields: string) => ({
        lean: async () =>
          fields === 'federation.activityId'
            ? []
            : [{ _id: 'parent1', threadId: 'root1', federation: { activityId: PARENT_URI } }],
      }),
    }));

    await importAuthorFeed(ACTOR);

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        federation: expect.objectContaining({ inReplyTo: PARENT_URI }),
        parentPostId: 'parent1',
        threadId: 'root1',
      }),
    );
  });

  it('resolves an embedded quote to a local quoteOf when the quoted post is imported', async () => {
    const QUOTED_URI = 'at://did:plc:quoted/app.bsky.feed.post/qkey';
    mocks.xrpcGet.mockResolvedValue({
      feed: [
        {
          post: postView('quoter', 'check this', {
            embed: {
              $type: 'app.bsky.embed.record#view',
              record: { $type: 'app.bsky.embed.record#viewRecord', uri: QUOTED_URI },
            },
          }),
        },
      ],
    });
    mocks.postFind.mockImplementation(() => ({
      select: (fields: string) => ({
        lean: async () =>
          fields === 'federation.activityId' ? [] : [{ _id: 'quoted1', federation: { activityId: QUOTED_URI } }],
      }),
    }));

    await importAuthorFeed(ACTOR);

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ quoteOf: 'quoted1' }));
  });

  it('resolves a mention facet (via the synced FederatedActor) into a placeholder + post.mentions', async () => {
    const MENTION_DID = 'did:plc:mentioned00000000000000';
    mocks.xrpcGet.mockResolvedValue({
      feed: [
        {
          post: postView('m', 'hi @bob.bsky.social!', {
            record: {
              facets: [
                {
                  index: { byteStart: 3, byteEnd: 19 },
                  features: [{ $type: 'app.bsky.richtext.facet#mention', did: MENTION_DID }],
                },
              ],
            },
          }),
        },
      ],
    });
    // The mentioned DID is already a synced actor → resolved from the cache (no
    // network fetch through `fetchAndUpsertAtprotoProfile`).
    mocks.federatedActorFindOne.mockReturnValue({
      select: () => ({ lean: async () => ({ oxyUserId: 'oxy-bob' }) }),
    });

    await importAuthorFeed(ACTOR);

    expect(mocks.federatedActorFindOne).toHaveBeenCalledWith({ uri: MENTION_DID });
    expect(mocks.fetchProfile).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mentions: ['oxy-bob'],
        content: expect.objectContaining({ text: 'hi [mention:oxy-bob]!' }),
      }),
    );
  });
});

/**
 * The MULTI-AUTHOR import path used by a feed generator's `getFeed` output. Unlike
 * `importAuthorFeed` (single actor), each post's author is resolved independently to
 * its federated Oxy user, and the returned AT-URIs preserve the generator's ranking.
 */
function makeActor(did: string, handle: string, oxyUserId: string): NormalizedExternalActor {
  return {
    network: 'atproto',
    externalId: did,
    handle,
    federatedUsername: `${handle}@bsky.social`,
    instanceDomain: 'bsky.social',
    oxyUserId,
  };
}

/** A feed PostView authored by an arbitrary DID (a generator mixes authors). */
function viewBy(authorDid: string, handle: string, rkey: string, text: string): Record<string, unknown> {
  return {
    uri: `at://${authorDid}/app.bsky.feed.post/${rkey}`,
    cid: 'cid',
    author: { did: authorDid, handle },
    record: { $type: 'app.bsky.feed.post', text, createdAt: '2024-01-01T00:00:00.000Z' },
    indexedAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('importPostViews', () => {
  const DID1 = 'did:plc:author1000000000000000';
  const DID2 = 'did:plc:author2000000000000000';
  const uri1 = `at://${DID1}/app.bsky.feed.post/p1`;
  const uri2 = `at://${DID2}/app.bsky.feed.post/p2`;
  const uri3 = `at://${DID1}/app.bsky.feed.post/p3`;

  it('resolves each distinct author, imports the new posts, and returns local URIs in ranking order', async () => {
    mocks.fetchProfile.mockImplementation(async (actor: string) => {
      if (actor === DID1) return makeActor(DID1, 'a1.bsky.social', 'oxy-a1');
      if (actor === DID2) return makeActor(DID2, 'a2.bsky.social', 'oxy-a2');
      return null;
    });
    // `uri3` was already imported → the dedup query returns it → not re-created, but
    // still returned in order (it has a local Post).
    mocks.postFind.mockReturnValue({
      select: () => ({ lean: async () => [{ federation: { activityId: uri3 } }] }),
    });

    const uris = await importPostViews([
      viewBy(DID1, 'a1.bsky.social', 'p1', 'from a1'),
      viewBy(DID2, 'a2.bsky.social', 'p2', 'from a2'),
      viewBy(DID1, 'a1.bsky.social', 'p3', 'also a1'),
    ]);

    // Every mapped URI returned in the generator's ranking (input) order.
    expect(uris).toEqual([uri1, uri2, uri3]);
    // Each DISTINCT author resolved once (deduped set).
    expect(mocks.fetchProfile).toHaveBeenCalledTimes(2);
    // Only the two NEW posts are created (uri3 was deduped), each stamped with ITS
    // OWN author's Oxy user — proving per-post ownership, not a single actor.
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls.map((call) => call[0].oxyUserId)).toEqual(['oxy-a1', 'oxy-a2']);
    expect(mocks.create.mock.calls[0][0].federation.activityId).toBe(uri1);
    expect(mocks.create.mock.calls[1][0].federation.activityId).toBe(uri2);
  });

  it('skips a post whose author cannot be resolved to an Oxy user (no orphan)', async () => {
    const GOOD = 'did:plc:good0000000000000000000';
    const BAD = 'did:plc:bad00000000000000000000';
    mocks.fetchProfile.mockImplementation(async (actor: string) =>
      actor === GOOD ? makeActor(GOOD, 'g.bsky.social', 'oxy-good') : null,
    );

    const uris = await importPostViews([
      viewBy(GOOD, 'g.bsky.social', 'g', 'ok'),
      viewBy(BAD, 'b.bsky.social', 'b', 'orphan'),
    ]);

    expect(uris).toEqual([`at://${GOOD}/app.bsky.feed.post/g`]);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0].oxyUserId).toBe('oxy-good');
  });
});
