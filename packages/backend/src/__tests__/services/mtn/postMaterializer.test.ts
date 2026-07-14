import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

/**
 * MTN PostMaterializer — `projectRecord` projection + idempotency tests.
 *
 * The `Post` / `Like` / `Bookmark` model statics are mocked with an in-memory
 * store so the REAL projection logic (collection routing, field-scoped `$set`,
 * media preservation, classification mirroring, tombstone removal, schema
 * validation) runs WITHOUT MongoDB. Mirrors the in-package model-mock pattern
 * from `scripts/migrateThreadFanToChain.test.ts`.
 */

// --- In-memory model store (built in vi.hoisted so it predates the mocks). ----
interface StoredDoc {
  _id: string;
  [key: string]: unknown;
}

const h = vi.hoisted(() => {
  const posts = new Map<string, StoredDoc>();
  const likes = new Map<string, StoredDoc>();
  const bookmarks = new Map<string, StoredDoc>();

  /**
   * Apply a dotted `$set` / `$setOnInsert` upsert into a map, mirroring Mongo's
   * dotted-path set semantics (so `content.text` nests under `content`). Existing
   * fields NOT named in `$set` are preserved (the zero-regression contract).
   */
  function applyUpsert(
    map: Map<string, StoredDoc>,
    id: string,
    update: { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> },
  ): StoredDoc {
    const isInsert = !map.has(id);
    const doc: StoredDoc = map.get(id) ?? { _id: id };
    const merged: Record<string, unknown> = { ...(update.$set ?? {}) };
    if (isInsert && update.$setOnInsert) {
      Object.assign(merged, update.$setOnInsert);
    }
    for (const [path, value] of Object.entries(merged)) {
      setDottedPath(doc, path, value);
    }
    map.set(id, doc);
    return doc;
  }

  function setDottedPath(target: Record<string, unknown>, path: string, value: unknown): void {
    const segments = path.split('.');
    let cursor = target;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (typeof cursor[seg] !== 'object' || cursor[seg] === null) {
        cursor[seg] = {};
      }
      cursor = cursor[seg] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1]] = value;
  }

  function findByIdAndUpdate(map: Map<string, StoredDoc>) {
    return vi.fn(
      async (
        id: string,
        update: { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> },
        options?: { upsert?: boolean },
      ) => {
        if (!map.has(id) && !options?.upsert) return null;
        return applyUpsert(map, id, update);
      },
    );
  }

  function findByIdAndDelete(map: Map<string, StoredDoc>) {
    return vi.fn(async (id: string) => {
      const existing = map.get(id) ?? null;
      map.delete(id);
      return existing;
    });
  }

  return {
    posts,
    likes,
    bookmarks,
    Post: { findByIdAndUpdate: findByIdAndUpdate(posts), findByIdAndDelete: findByIdAndDelete(posts) },
    Like: { findByIdAndUpdate: findByIdAndUpdate(likes), findByIdAndDelete: findByIdAndDelete(likes) },
    Bookmark: {
      findByIdAndUpdate: findByIdAndUpdate(bookmarks),
      findByIdAndDelete: findByIdAndDelete(bookmarks),
    },
  };
});

vi.mock('../../../models/Post', () => ({
  Post: h.Post,
  POST_CLASSIFICATION_PENDING: 'pending',
}));
vi.mock('../../../models/Like', () => ({ default: h.Like }));
vi.mock('../../../models/Bookmark', () => ({ default: h.Bookmark }));

// Mock the service-scoped Oxy client so the read-side blob resolver's REVERSE
// lookup (`getServiceAssetMetadataBySha256`, sha256 → fileId) is fully
// controllable and performs no real I/O. Hoisted so it predates the import.
const oxyMock = vi.hoisted(() => ({
  getServiceAssetMetadataBySha256: vi.fn<
    (sha256s: string[]) => Promise<
      Array<{ sha256: string; id: string; mime: string; size: number; status: 'active' | 'trash'; url?: string }>
    >
  >(),
}));
vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => oxyMock,
}));

import { projectRecord } from '../../../services/mtn/PostMaterializer';
import { buildUserDid } from '../../../services/mtn/mentionDid';
import { baselineContentClassifier } from '../../../services/BaselineContentClassifier';
import {
  MENTION_POST_COLLECTION,
  MENTION_LIKE_COLLECTION,
  MENTION_REPOST_COLLECTION,
  MENTION_TOMBSTONE_COLLECTION,
  MENTION_BOOKMARK_COLLECTION,
  createPostUri,
  createLikeUri,
  createBookmarkUri,
} from '@mention/shared-types';

const SUBJECT_OXY_ID = '650000000000000000000abc';
const SUBJECT_DID = buildUserDid(SUBJECT_OXY_ID);
// 24-hex Mongo ObjectId strings used as rkeys / post ids.
const POST_RKEY = '650000000000000000000001';
const LIKE_RKEY = '650000000000000000000002';
const REPOST_RKEY = '650000000000000000000003';
const BOOKMARK_RKEY = '650000000000000000000004';
const LIKED_POST_ID = '650000000000000000000005';
const OWNER_OXY_ID = '650000000000000000000fff';

/** Build a v2 envelope around an inner `record` for the materializer to project. */
function envelope(
  collection: string,
  rkey: string,
  record: Record<string, unknown>,
  subject = SUBJECT_DID,
): SignedRecordEnvelope {
  return {
    version: 2,
    type: 'app_record',
    subject,
    issuer: 'did:web:mention.earth',
    record,
    issuedAt: Date.now(),
    seq: 0,
    prev: null,
    collection,
    rkey,
    publicKey: 'pub',
    alg: 'ES256K-DER-SHA256',
    signature: 'sig',
  };
}

beforeEach(() => {
  h.posts.clear();
  h.likes.clear();
  h.bookmarks.clear();
  h.Post.findByIdAndUpdate.mockClear();
  h.Post.findByIdAndDelete.mockClear();
  h.Like.findByIdAndUpdate.mockClear();
  h.Like.findByIdAndDelete.mockClear();
  h.Bookmark.findByIdAndUpdate.mockClear();
  h.Bookmark.findByIdAndDelete.mockClear();
  // Default: no blob resolves (records without embeds are unaffected). Tests that
  // exercise the resolver override this per-case.
  oxyMock.getServiceAssetMetadataBySha256.mockReset();
  oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([]);
});

describe('projectRecord — post', () => {
  const createdAtIso = '2024-01-02T03:04:05.000Z';
  const postRecord = {
    text: 'hello materialized world from the chain',
    createdAt: createdAtIso,
    tags: ['mtn', 'protocol'],
    langs: ['en'],
  };

  it('projects a post record into a feed-identical Post row', async () => {
    const result = await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));

    expect(result).toEqual({ ok: true, kind: 'post', id: POST_RKEY });
    const doc = h.posts.get(POST_RKEY);
    expect(doc).toBeDefined();
    expect(doc?.oxyUserId).toBe(SUBJECT_OXY_ID);
    expect(doc?.type).toBe('text');
    // The body lives in the variants — `variants[0]` is the primary rendition.
    expect((doc?.content as { variants: Array<{ text: string }> }).variants[0].text).toBe(postRecord.text);
    expect(doc?.hashtags).toEqual(['mtn', 'protocol']);
    expect(doc?.parentPostId).toBeNull();
    expect(doc?.threadId).toBeNull();
    expect((doc?.createdAt as Date).toISOString()).toBe(createdAtIso);
    // Insert-only defaults applied.
    expect(doc?.visibility).toBe('public');
    expect(doc?.status).toBe('published');
  });

  it('writes a postClassification identical to baselineContentClassifier output', async () => {
    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));

    const expected = baselineContentClassifier.classify({
      text: postRecord.text,
      hashtags: postRecord.tags,
      language: postRecord.langs[0],
      languages: postRecord.langs,
    });

    const doc = h.posts.get(POST_RKEY);
    const classification = doc?.postClassification as {
      status: string;
      topics: string[];
      languages: string[];
      hashtagsNorm: string[];
      sensitive?: boolean;
      version: number;
    };
    expect(classification.status).toBe('pending');
    expect(classification.topics).toEqual(expected.topics);
    expect(classification.languages).toEqual(expected.languages);
    expect(classification.hashtagsNorm).toEqual(expected.hashtagsNorm);
    expect(classification.sensitive).toBe(expected.sensitive);
    expect(classification.version).toBe(expected.version);
    // Top-level primary language mirrors PostCreationService.
    expect(doc?.language).toBe(expected.languages[0]);
  });

  it('is idempotent on a second projection (same row, stable classification)', async () => {
    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));
    const first = JSON.parse(JSON.stringify(h.posts.get(POST_RKEY)));

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));
    const second = JSON.parse(JSON.stringify(h.posts.get(POST_RKEY)));

    // Exactly one row, and its content/structure is stable across re-projection
    // (classifiedAt is a timestamp, so compare the stable fields).
    expect(h.posts.size).toBe(1);
    expect(second.oxyUserId).toBe(first.oxyUserId);
    expect(second.content).toEqual(first.content);
    expect(second.hashtags).toEqual(first.hashtags);
    expect(second.postClassification.topics).toEqual(first.postClassification.topics);
    expect(second.postClassification.languages).toEqual(first.postClassification.languages);
  });

  it('recovers reply context (threadId=root rkey, parentPostId=parent rkey)', async () => {
    const rootId = '650000000000000000000010';
    const parentId = '650000000000000000000011';
    const replyRecord = {
      text: 'a reply in a thread that is long enough to classify',
      createdAt: createdAtIso,
      reply: {
        root: createPostUri(OWNER_OXY_ID, rootId),
        parent: createPostUri(OWNER_OXY_ID, parentId),
      },
    };

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, replyRecord));

    const doc = h.posts.get(POST_RKEY);
    expect(doc?.threadId).toBe(rootId);
    expect(doc?.parentPostId).toBe(parentId);
  });

  it('PRESERVES existing content.media (BLOB DEFERRED — never clobbers to empty)', async () => {
    // Seed an existing post that already carries fileId media (the B2 corpus case).
    h.posts.set(POST_RKEY, {
      _id: POST_RKEY,
      oxyUserId: SUBJECT_OXY_ID,
      content: {
        text: 'original',
        media: [{ id: 'file-abc', type: 'image' }],
      },
    });

    const result = await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));
    expect(result.ok).toBe(true);

    const doc = h.posts.get(POST_RKEY);
    const content = doc?.content as {
      variants: Array<{ text: string }>;
      media: Array<{ id: string; type: string }>;
    };
    // The body was updated from the record…
    expect(content.variants[0].text).toBe(postRecord.text);
    // …but the fileId media survives (the materializer never writes content.media).
    expect(content.media).toEqual([{ id: 'file-abc', type: 'image' }]);
  });

  it('READ-SIDE: resolves a blob embed (sha256) → fileId MediaItem via reverse lookup', async () => {
    // The write side emits content-addressed blob refs; the read side resolves
    // each sha256 back to its live Oxy fileId and writes a native content.media
    // MediaItem, so the post renders through the normal CDN path.
    oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([
      { sha256: 'sha-img', id: 'file-img', mime: 'image/png', size: 42, status: 'active' },
      { sha256: 'sha-vid', id: 'file-vid', mime: 'video/mp4', size: 99, status: 'active' },
    ]);

    const recordWithEmbed = {
      ...postRecord,
      embed: {
        type: 'media',
        items: [
          { blob: { sha256: 'sha-img', mediaType: 'image', mime: 'image/png', size: 42 }, alt: 'a cat' },
          { blob: { sha256: 'sha-vid', mediaType: 'video', mime: 'video/mp4', size: 99 } },
        ],
      },
    };

    const result = await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, recordWithEmbed));
    expect(result).toEqual({ ok: true, kind: 'post', id: POST_RKEY });

    // The reverse lookup is called once with the embed's distinct sha256s.
    expect(oxyMock.getServiceAssetMetadataBySha256).toHaveBeenCalledTimes(1);
    expect(oxyMock.getServiceAssetMetadataBySha256).toHaveBeenCalledWith(['sha-img', 'sha-vid']);

    const doc = h.posts.get(POST_RKEY);
    const content = doc?.content as {
      variants: Array<{ text: string }>;
      media: Array<{ id: string; type: string; alt?: string }>;
    };
    expect(content.variants[0].text).toBe(postRecord.text);
    // Each blob became a fileId MediaItem (id = resolved fileId, type = mediaType),
    // order + alt preserved.
    expect(content.media).toEqual([
      { id: 'file-img', type: 'image', alt: 'a cat' },
      { id: 'file-vid', type: 'video' },
    ]);
  });

  it('READ-SIDE FAIL-SOFT: an unresolvable sha256 is dropped (no fake URL)', async () => {
    // Only one of two blobs resolves; the other (unknown/trashed) is omitted by
    // the upstream batch. The materializer drops it rather than inventing a URL.
    oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([
      { sha256: 'sha-ok', id: 'file-ok', mime: 'image/jpeg', size: 10, status: 'active' },
      // sha-trash present but trashed → not renderable, treated as unresolvable.
      { sha256: 'sha-trash', id: 'file-trash', mime: 'image/jpeg', size: 11, status: 'trash' },
      // sha-missing simply absent from the response.
    ]);

    const recordWithEmbed = {
      ...postRecord,
      embed: {
        type: 'media',
        items: [
          { blob: { sha256: 'sha-ok', mediaType: 'image' } },
          { blob: { sha256: 'sha-trash', mediaType: 'image' } },
          { blob: { sha256: 'sha-missing', mediaType: 'image' } },
        ],
      },
    };

    const result = await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, recordWithEmbed));
    expect(result.ok).toBe(true);

    const doc = h.posts.get(POST_RKEY);
    const content = doc?.content as { media: Array<{ id: string; type: string }> };
    // Only the single resolvable, active blob survived.
    expect(content.media).toEqual([{ id: 'file-ok', type: 'image' }]);
  });

  it('READ-SIDE FAIL-SOFT: a reverse-lookup error never aborts projection (no media written)', async () => {
    oxyMock.getServiceAssetMetadataBySha256.mockRejectedValue(new Error('403 forbidden: files:read'));

    const recordWithEmbed = {
      ...postRecord,
      embed: {
        type: 'media',
        items: [{ blob: { sha256: 'sha-x', mediaType: 'image' } }],
      },
    };

    const result = await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, recordWithEmbed));
    expect(result).toEqual({ ok: true, kind: 'post', id: POST_RKEY });

    const doc = h.posts.get(POST_RKEY);
    const content = doc?.content as { variants: Array<{ text: string }>; media?: unknown };
    expect(content.variants[0].text).toBe(postRecord.text);
    // Lookup failed → no media materialized, no throw.
    expect(content.media).toBeUndefined();
  });

  it('READ-SIDE ZERO-REGRESSION: an empty resolution preserves existing fileId media', async () => {
    // Existing post already carries fileId media. The incoming record carries a
    // blob embed whose sha256 does NOT resolve → resolver returns [] → the upsert
    // must NOT write content.media, so the existing media survives.
    h.posts.set(POST_RKEY, {
      _id: POST_RKEY,
      oxyUserId: SUBJECT_OXY_ID,
      content: { text: 'original', media: [{ id: 'file-existing', type: 'image' }] },
    });
    oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([]); // nothing resolves

    const recordWithEmbed = {
      ...postRecord,
      embed: {
        type: 'media',
        items: [{ blob: { sha256: 'sha-unresolved', mediaType: 'image' } }],
      },
    };

    const result = await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, recordWithEmbed));
    expect(result.ok).toBe(true);

    const doc = h.posts.get(POST_RKEY);
    const content = doc?.content as {
      variants: Array<{ text: string }>;
      media: Array<{ id: string; type: string }>;
    };
    expect(content.variants[0].text).toBe(postRecord.text);
    // Existing fileId media preserved (resolver returned nothing → no write).
    expect(content.media).toEqual([{ id: 'file-existing', type: 'image' }]);
  });

  it('rejects an invalid inner record with reason invalid_record', async () => {
    // `text` is required by mentionPostRecordSchema; omit it.
    const result = await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, { createdAt: createdAtIso }),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_record' });
    expect(h.posts.size).toBe(0);
  });

  it('is a clear no-op for a non-parseable subject DID', async () => {
    const result = await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord, 'did:web:not-a-user-did'),
    );
    expect(result).toEqual({ ok: false, reason: 'unresolvable_subject_did' });
    expect(h.posts.size).toBe(0);
  });
});

describe('projectRecord — like', () => {
  it('projects a like record into a Like row', async () => {
    const likeRecord = {
      subject: createPostUri(OWNER_OXY_ID, LIKED_POST_ID),
      createdAt: '2024-01-02T03:04:05.000Z',
    };
    const result = await projectRecord(envelope(MENTION_LIKE_COLLECTION, LIKE_RKEY, likeRecord));

    expect(result).toEqual({ ok: true, kind: 'like', id: LIKE_RKEY });
    const doc = h.likes.get(LIKE_RKEY);
    expect(doc?.userId).toBe(SUBJECT_OXY_ID);
    expect((doc?.postId as mongoose.Types.ObjectId).toString()).toBe(LIKED_POST_ID);
    expect(doc?.value).toBe(1);
  });
});

describe('projectRecord — repost', () => {
  it('projects a repost record into a boost Post (type boost, boostOf set, empty body)', async () => {
    const repostRecord = {
      subject: createPostUri(OWNER_OXY_ID, LIKED_POST_ID),
      createdAt: '2024-01-02T03:04:05.000Z',
    };
    const result = await projectRecord(envelope(MENTION_REPOST_COLLECTION, REPOST_RKEY, repostRecord));

    expect(result).toEqual({ ok: true, kind: 'repost', id: REPOST_RKEY });
    const doc = h.posts.get(REPOST_RKEY);
    expect(doc?.type).toBe('boost');
    expect(doc?.boostOf).toBe(LIKED_POST_ID);
    expect(doc?.oxyUserId).toBe(SUBJECT_OXY_ID);
    // No rendition at all — a boost has nothing to say in any language.
    expect((doc?.content as { variants: unknown[] }).variants).toEqual([]);
  });
});

describe('projectRecord — bookmark', () => {
  it('projects a bookmark record into a Bookmark row', async () => {
    const bookmarkRecord = {
      subject: createPostUri(OWNER_OXY_ID, LIKED_POST_ID),
      createdAt: '2024-01-02T03:04:05.000Z',
    };
    const result = await projectRecord(
      envelope(MENTION_BOOKMARK_COLLECTION, BOOKMARK_RKEY, bookmarkRecord),
    );

    expect(result).toEqual({ ok: true, kind: 'bookmark', id: BOOKMARK_RKEY });
    const doc = h.bookmarks.get(BOOKMARK_RKEY);
    expect(doc?.userId).toBe(SUBJECT_OXY_ID);
    expect((doc?.postId as mongoose.Types.ObjectId).toString()).toBe(LIKED_POST_ID);
  });
});

describe('projectRecord — tombstone', () => {
  it('removes the referenced Post for a post-subject tombstone', async () => {
    h.posts.set(POST_RKEY, { _id: POST_RKEY, oxyUserId: SUBJECT_OXY_ID });
    const tombstone = {
      subject: createPostUri(SUBJECT_OXY_ID, POST_RKEY),
      createdAt: '2024-01-02T03:04:05.000Z',
    };

    const result = await projectRecord(
      envelope(MENTION_TOMBSTONE_COLLECTION, '650000000000000000000099', tombstone),
    );

    expect(result).toEqual({ ok: true, kind: 'tombstone', id: POST_RKEY });
    expect(h.posts.has(POST_RKEY)).toBe(false);
  });

  it('removes the referenced Like for a like-subject tombstone', async () => {
    h.likes.set(LIKE_RKEY, { _id: LIKE_RKEY, userId: SUBJECT_OXY_ID });
    const tombstone = {
      subject: createLikeUri(SUBJECT_OXY_ID, LIKE_RKEY),
      createdAt: '2024-01-02T03:04:05.000Z',
    };

    const result = await projectRecord(
      envelope(MENTION_TOMBSTONE_COLLECTION, '650000000000000000000098', tombstone),
    );

    expect(result).toEqual({ ok: true, kind: 'tombstone', id: LIKE_RKEY });
    expect(h.likes.has(LIKE_RKEY)).toBe(false);
  });

  it('removes the referenced Bookmark for a bookmark-subject tombstone', async () => {
    h.bookmarks.set(BOOKMARK_RKEY, { _id: BOOKMARK_RKEY, userId: SUBJECT_OXY_ID });
    const tombstone = {
      subject: createBookmarkUri(SUBJECT_OXY_ID, BOOKMARK_RKEY),
      createdAt: '2024-01-02T03:04:05.000Z',
    };

    const result = await projectRecord(
      envelope(MENTION_TOMBSTONE_COLLECTION, '650000000000000000000097', tombstone),
    );

    expect(result).toEqual({ ok: true, kind: 'tombstone', id: BOOKMARK_RKEY });
    expect(h.bookmarks.has(BOOKMARK_RKEY)).toBe(false);
  });

  it('is idempotent: tombstoning an already-removed row is a no-op success', async () => {
    const tombstone = {
      subject: createPostUri(SUBJECT_OXY_ID, POST_RKEY),
      createdAt: '2024-01-02T03:04:05.000Z',
    };
    const result = await projectRecord(
      envelope(MENTION_TOMBSTONE_COLLECTION, '650000000000000000000096', tombstone),
    );
    expect(result.ok).toBe(true);
  });
});

describe('projectRecord — multilingual post (variants)', () => {
  const createdAtIso = '2024-01-02T03:04:05.000Z';

  it('materializes the record variants as AUTHOR variants', async () => {
    const record = {
      text: 'hola mundo',
      createdAt: createdAtIso,
      langs: ['es-ES', 'en-US'],
      variants: [
        { tag: 'es-ES', text: 'hola mundo' },
        { tag: 'en-US', text: 'hello world' },
      ],
    };

    const result = await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, record));
    expect(result).toEqual({ ok: true, kind: 'post', id: POST_RKEY });

    const doc = h.posts.get(POST_RKEY);
    const content = doc?.content as { variants: Array<{ tag?: string; source: string; text: string }> };
    // Everything on the chain is author-written — a machine translation is never
    // signed, so there is nothing else it could be. `variants[0]` is the primary.
    expect(content.variants).toEqual([
      { tag: 'es-ES', source: 'author', text: 'hola mundo', createdAt: createdAtIso },
      { tag: 'en-US', source: 'author', text: 'hello world', createdAt: createdAtIso },
    ]);
    // The top-level AP `language` is the BASE subtag — the alphabet the ranking
    // layer reads — even though the record's `langs` are regional.
    expect(doc?.language).toBe('es');
  });

  it('re-keys a variant alt map from blob sha256 back to the live Oxy file id', async () => {
    oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([
      { sha256: 'sha-img', id: 'file-img', mime: 'image/png', size: 10, status: 'active' },
    ]);
    const record = {
      text: 'hola',
      createdAt: createdAtIso,
      langs: ['es'],
      embed: { type: 'media', items: [{ blob: { sha256: 'sha-img', mediaType: 'image' }, alt: 'un gato' }] },
      variants: [
        { tag: 'es', text: 'hola' },
        { tag: 'en', text: 'hi', alt: { 'sha-img': 'a cat' } },
      ],
    };

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, record));

    const content = h.posts.get(POST_RKEY)?.content as {
      media: Array<{ id: string; alt?: string }>;
      variants: Array<{ tag: string; alt?: Record<string, string> }>;
    };
    // ONE batched reverse lookup covers the shared embed AND the variant alt keys.
    expect(oxyMock.getServiceAssetMetadataBySha256).toHaveBeenCalledTimes(1);
    expect(content.media).toEqual([{ id: 'file-img', type: 'image', alt: 'un gato' }]);
    expect(content.variants[1].alt).toEqual({ 'file-img': 'a cat' });
  });

  it('rebuilds the single rendition of a MONOLINGUAL record from `text` + `langs`', async () => {
    // The writer omits a one-entry `variants` array (it would just duplicate
    // `text`), so the reader reconstitutes it. This is also the DEGRADATION path:
    // a record written by a reader that never heard of `variants` still
    // materializes a complete, correctly-tagged post.
    const record = { text: 'hola', createdAt: createdAtIso, langs: ['es-ES'] };

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, record));

    const content = h.posts.get(POST_RKEY)?.content as { variants: Array<{ tag?: string; text: string }> };
    expect(content.variants).toEqual([
      { tag: 'es-ES', source: 'author', text: 'hola', createdAt: createdAtIso },
    ]);
  });

  it('materializes an UNTAGGED rendition when the record declares no language', async () => {
    const record = { text: '+1', createdAt: createdAtIso };

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, record));

    const content = h.posts.get(POST_RKEY)?.content as { variants: Array<{ tag?: string; text: string }> };
    expect(content.variants).toEqual([{ source: 'author', text: '+1', createdAt: createdAtIso }]);
    expect(content.variants[0].tag).toBeUndefined();
  });
});
