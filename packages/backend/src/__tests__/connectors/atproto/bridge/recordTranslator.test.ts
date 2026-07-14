import { describe, it, expect } from 'vitest';
import {
  MENTION_POST_COLLECTION,
  MENTION_LIKE_COLLECTION,
  MENTION_REPOST_COLLECTION,
  createPostUri,
  createLikeUri,
  type MentionPostRecord,
  type MentionLikeRecord,
  type MentionRepostRecord,
} from '@mention/shared-types';
import { buildUserDid } from '../../../../services/mtn/mentionDid';
import {
  translatePostRecord,
  translateLikeRecord,
  translateRepostRecord,
  mtnUriToStrongRef,
  buildBridgeAtUri,
  mtnRecordIdToCid,
  postEmbedBlobViews,
  MTN_TO_BSKY_COLLECTION,
  BSKY_TO_MTN_COLLECTION,
} from '../../../../connectors/atproto/bridge/recordTranslator';

/**
 * Phase C4 — MTN → atproto record TRANSLATION (pure, no DB / no network).
 *
 * Verifies the projection of `app.mention.feed.*` payloads into `app.bsky.feed.*`
 * record values: post text/facets/reply/langs/tags/embed, like/repost subject
 * strong refs, and the MTN-URI → AT-URI translation.
 */

const OWNER = '650000000000000000000abc';
const OTHER = '650000000000000000000def';

describe('collection mapping', () => {
  it('maps every MTN feed collection to its served app.bsky equivalent and back', () => {
    expect(MTN_TO_BSKY_COLLECTION[MENTION_POST_COLLECTION]).toBe('app.bsky.feed.post');
    expect(MTN_TO_BSKY_COLLECTION[MENTION_LIKE_COLLECTION]).toBe('app.bsky.feed.like');
    expect(MTN_TO_BSKY_COLLECTION[MENTION_REPOST_COLLECTION]).toBe('app.bsky.feed.repost');
    expect(BSKY_TO_MTN_COLLECTION['app.bsky.feed.post']).toBe(MENTION_POST_COLLECTION);
    expect(BSKY_TO_MTN_COLLECTION['app.bsky.feed.repost']).toBe(MENTION_REPOST_COLLECTION);
  });
});

describe('buildBridgeAtUri / mtnRecordIdToCid', () => {
  it('builds an AT-URI under the user did:web subject', () => {
    expect(buildBridgeAtUri(OWNER, 'app.bsky.feed.post', 'post1')).toBe(
      `at://${buildUserDid(OWNER)}/app.bsky.feed.post/post1`,
    );
  });

  it('derives a deterministic placeholder CID, never a bare empty string', () => {
    expect(mtnRecordIdToCid('abc123')).toBe('mtn-abc123');
    expect(mtnRecordIdToCid(undefined)).toBe('mtn-unknown');
    expect(mtnRecordIdToCid('')).toBe('mtn-unknown');
  });
});

describe('mtnUriToStrongRef', () => {
  it('translates an MTN post URI to an at:// strong ref', () => {
    const ref = mtnUriToStrongRef(createPostUri(OWNER, 'post1'));
    expect(ref).toEqual({
      uri: `at://${buildUserDid(OWNER)}/app.bsky.feed.post/post1`,
      cid: 'mtn-post1',
    });
  });

  it('returns null for a malformed MTN URI', () => {
    expect(mtnUriToStrongRef('not-an-mtn-uri')).toBeNull();
  });

  it('returns null for an MTN collection with no served atproto equivalent', () => {
    // A bookmark/tombstone MTN URI has no served bsky collection.
    expect(mtnUriToStrongRef(`mtn://${OWNER}/app.mention.feed.bookmark/b1`)).toBeNull();
  });
});

describe('translatePostRecord', () => {
  it('maps a minimal post to app.bsky.feed.post', () => {
    const record: MentionPostRecord = { text: 'hello world', createdAt: '2026-06-30T00:00:00.000Z' };
    expect(translatePostRecord(record)).toEqual({
      $type: 'app.bsky.feed.post',
      text: 'hello world',
      createdAt: '2026-06-30T00:00:00.000Z',
    });
  });

  it('emits the PRIMARY body of a multilingual post — an app.bsky.feed.post has ONE body + langs', () => {
    // Bluesky's post lexicon has no `contentMap` equivalent: one `text`, plus the
    // `langs` codes. So a multilingual MTN record bridges as its primary body and
    // the full language set — never as two bodies, and never as a concatenation.
    const record: MentionPostRecord = {
      text: 'hola mundo',
      createdAt: '2026-06-30T00:00:00.000Z',
      langs: ['es', 'en'],
      variants: [
        { tag: 'es-ES', text: 'hola mundo' },
        { tag: 'en-US', text: 'hello world' },
      ],
    };

    const out = translatePostRecord(record);
    expect(out.text).toBe('hola mundo');
    expect(out.langs).toEqual(['es', 'en']);
    expect(out).not.toHaveProperty('variants');
  });

  it('maps facets (mention/link/hashtag) to app.bsky.richtext.facet', () => {
    const record: MentionPostRecord = {
      text: 'hi @x #tag http://e.com',
      createdAt: '2026-06-30T00:00:00.000Z',
      facets: [
        {
          index: { byteStart: 3, byteEnd: 5 },
          features: [
            { type: 'mention', did: 'did:web:oxy.so:u:xyz' },
            { type: 'link', uri: 'http://e.com' },
            { type: 'hashtag', tag: 'tag' },
          ],
        },
      ],
    };
    const out = translatePostRecord(record);
    expect(out.facets).toEqual([
      {
        $type: 'app.bsky.richtext.facet',
        index: { byteStart: 3, byteEnd: 5 },
        features: [
          { $type: 'app.bsky.richtext.facet#mention', did: 'did:web:oxy.so:u:xyz' },
          { $type: 'app.bsky.richtext.facet#link', uri: 'http://e.com' },
          { $type: 'app.bsky.richtext.facet#tag', tag: 'tag' },
        ],
      },
    ]);
  });

  it('maps reply root/parent MTN URIs to a bsky replyRef', () => {
    const record: MentionPostRecord = {
      text: 'a reply',
      createdAt: '2026-06-30T00:00:00.000Z',
      reply: { root: createPostUri(OTHER, 'root1'), parent: createPostUri(OTHER, 'parent1') },
    };
    const out = translatePostRecord(record);
    expect(out.reply).toEqual({
      root: { uri: `at://${buildUserDid(OTHER)}/app.bsky.feed.post/root1`, cid: 'mtn-root1' },
      parent: { uri: `at://${buildUserDid(OTHER)}/app.bsky.feed.post/parent1`, cid: 'mtn-parent1' },
    });
  });

  it('carries langs and tags through', () => {
    const record: MentionPostRecord = {
      text: 'multilingual',
      createdAt: '2026-06-30T00:00:00.000Z',
      langs: ['en', 'es'],
      tags: ['news', 'tech'],
    };
    const out = translatePostRecord(record);
    expect(out.langs).toEqual(['en', 'es']);
    expect(out.tags).toEqual(['news', 'tech']);
  });

  it('projects image embeds to app.bsky.embed.images, dropping non-image blobs', () => {
    const record: MentionPostRecord = {
      text: 'with media',
      createdAt: '2026-06-30T00:00:00.000Z',
      embed: {
        type: 'media',
        items: [
          { blob: { sha256: 'imgsha', mediaType: 'image', mime: 'image/png', size: 1234 }, alt: 'an image' },
          { blob: { sha256: 'vidsha', mediaType: 'video' } },
        ],
      },
    };
    const out = translatePostRecord(record);
    expect(out.embed).toEqual({
      $type: 'app.bsky.embed.images',
      images: [
        {
          alt: 'an image',
          image: { $type: 'blob', ref: { $link: 'imgsha' }, mimeType: 'image/png', size: 1234 },
        },
      ],
    });
  });

  it('omits the embed entirely when only non-image blobs are present', () => {
    const record: MentionPostRecord = {
      text: 'video only',
      createdAt: '2026-06-30T00:00:00.000Z',
      embed: { type: 'media', items: [{ blob: { sha256: 'v', mediaType: 'video' } }] },
    };
    expect(translatePostRecord(record).embed).toBeUndefined();
  });
});

describe('translateLikeRecord / translateRepostRecord', () => {
  it('translates a like subject to a strong ref', () => {
    const record: MentionLikeRecord = {
      subject: createPostUri(OTHER, 'liked1'),
      createdAt: '2026-06-30T00:00:00.000Z',
    };
    expect(translateLikeRecord(record)).toEqual({
      $type: 'app.bsky.feed.like',
      subject: { uri: `at://${buildUserDid(OTHER)}/app.bsky.feed.post/liked1`, cid: 'mtn-liked1' },
      createdAt: '2026-06-30T00:00:00.000Z',
    });
  });

  it('translates a repost subject to a strong ref', () => {
    const record: MentionRepostRecord = {
      subject: createPostUri(OTHER, 'rp1'),
      createdAt: '2026-06-30T00:00:00.000Z',
    };
    expect(translateRepostRecord(record)?.$type).toBe('app.bsky.feed.repost');
  });

  it('returns null when the like subject points at a non-projected collection', () => {
    const record: MentionLikeRecord = {
      subject: `mtn://${OTHER}/app.mention.feed.bookmark/b1`,
      createdAt: '2026-06-30T00:00:00.000Z',
    };
    expect(translateLikeRecord(record)).toBeNull();
  });
});

describe('postEmbedBlobViews', () => {
  it('surfaces blob content addresses for a post embed', () => {
    const record: MentionPostRecord = {
      text: 'media',
      createdAt: '2026-06-30T00:00:00.000Z',
      embed: { type: 'media', items: [{ blob: { sha256: 'abc', mediaType: 'image', mime: 'image/jpeg', size: 9 } }] },
    };
    expect(postEmbedBlobViews(record)).toEqual([
      { sha256: 'abc', mediaType: 'image', mime: 'image/jpeg', size: 9, contentRef: 'abc' },
    ]);
  });

  it('returns an empty array for a post with no embed', () => {
    expect(postEmbedBlobViews({ text: 'x', createdAt: '2026-06-30T00:00:00.000Z' })).toEqual([]);
  });
});

// Sanity: the like-uri helper round-trips through the strong-ref translator.
describe('integration: like uri round-trip', () => {
  it('a like uri built by the shared helper translates to a stable at-uri', () => {
    const ref = mtnUriToStrongRef(createLikeUri(OWNER, 'like1'));
    expect(ref?.uri).toBe(`at://${buildUserDid(OWNER)}/app.bsky.feed.like/like1`);
  });
});
