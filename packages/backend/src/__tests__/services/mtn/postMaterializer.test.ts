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
    expect((doc?.content as { text: string }).text).toBe(postRecord.text);
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
    const content = doc?.content as { text: string; media: Array<{ id: string; type: string }> };
    // Text was updated from the record…
    expect(content.text).toBe(postRecord.text);
    // …but the fileId media survives (the materializer never writes content.media).
    expect(content.media).toEqual([{ id: 'file-abc', type: 'image' }]);
  });

  it('READ-SIDE DEFERRED: a record that CARRIES a blob embed never writes content.media', async () => {
    // The write side now emits content-addressed blob refs, but the read side
    // cannot turn a bare sha256 back into a servable fileId/URL (no reverse
    // upstream index). The materializer must NOT write content.media from the
    // embed — for a NEW post that means no media key at all (no fake URLs), and
    // for an existing post the fileId media is preserved (other test below).
    const recordWithEmbed = {
      ...postRecord,
      embed: {
        type: 'media',
        items: [{ blob: { sha256: 'sha-from-chain', mediaType: 'image', mime: 'image/png', size: 42 } }],
      },
    };

    const result = await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, recordWithEmbed));
    expect(result).toEqual({ ok: true, kind: 'post', id: POST_RKEY });

    const doc = h.posts.get(POST_RKEY);
    const content = doc?.content as { text: string; media?: unknown };
    expect(content.text).toBe(postRecord.text);
    // No media materialized from the blob embed (deferred read side, no fake URL).
    expect(content.media).toBeUndefined();
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
    expect((doc?.content as { text: string }).text).toBe('');
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
