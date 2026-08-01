/**
 * MTN `projectRecord` — a signed record becoming real rows.
 *
 * The suite this replaces ran the projection against an in-memory
 * re-implementation of Mongo's dotted-`$set` semantics. That could only ever
 * assert that the code built the update it was written to build; it could not see
 * the two things this port makes possible to get wrong, and both are silent:
 *
 * **A post is SIX tables now.** The body is `post_content_variants`, the media is
 * `post_media`, the owner is `post_authorships`. Writing the parent row alone
 * produces a post that exists, satisfies every foreign key, is returned by every
 * feed query — and renders as an empty card, with no error anywhere. Every case
 * below reads the post back through `loadPostRecord`, which is the same assembly
 * hydration and the feed engine use, so a missing child row is a missing field
 * here.
 *
 * **Re-projection is now a delete-and-rewrite of the content graph**, where Mongo
 * touched only the paths it named. Anything the record does NOT own — an existing
 * post's media that would not re-resolve, its @mention allowlist, its article —
 * has to be carried across explicitly, and the cases that check that are the ones
 * that go red if `mergeRecordContent` is simplified away.
 *
 * The Oxy blob lookup stays mocked: it is a network call, and it is the input the
 * read-side resolution cases need to control. Everything else is real, including
 * `PostEngagementCommandService` — so a like record has to satisfy the same
 * foreign key a native like does.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

// The service-scoped Oxy client, so the read-side blob resolver's REVERSE lookup
// (`getServiceAssetMetadataBySha256`, sha256 → fileId) is controllable and does
// no real I/O. Hoisted so it predates the import.
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

import { closePostgres, connectPostgres, type Database } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import { bookmarks, likes } from '../../../db/schema/engagement';
import { postRecentRepliers } from '../../../db/schema/postContent';
import { insertPostRecord, loadPostRecord } from '../../../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../../../db/posts/postRecord';
import { projectRecord } from '../../../services/mtn/PostMaterializer';
import { buildUserDid } from '../../../services/mtn/mentionDid';
import { baselineContentClassifier } from '../../../services/BaselineContentClassifier';
import { buildAuthorship } from '../../../utils/postAuthorship';
import {
  MENTION_POST_COLLECTION,
  MENTION_LIKE_COLLECTION,
  MENTION_REPOST_COLLECTION,
  MENTION_TOMBSTONE_COLLECTION,
  MENTION_BOOKMARK_COLLECTION,
  PostType,
  PostVisibility,
  createPostUri,
  createLikeUri,
  createBookmarkUri,
} from '@mention/shared-types';

let db: Database;

const SUBJECT_OXY_ID = '650000000000000000000abc';
const SUBJECT_DID = buildUserDid(SUBJECT_OXY_ID);
const OWNER_OXY_ID = '650000000000000000000fff';

/**
 * Every post id this suite writes.
 *
 * They are the rkeys the records name, so they are also the PRIMARY KEY — and
 * vitest runs test FILES in parallel against ONE database, so the prefix has to
 * be unique to this file or an unrelated suite's insert collides with ours.
 */
const NAMESPACE = '65000000000000000mtn';
const POST_RKEY = `${NAMESPACE}0001`;
const LIKE_RKEY = `${NAMESPACE}0002`;
const REPOST_RKEY = `${NAMESPACE}0003`;
const BOOKMARK_RKEY = `${NAMESPACE}0004`;
const LIKED_POST_ID = `${NAMESPACE}0005`;
const PARENT_RKEY = `${NAMESPACE}0006`;
const ROOT_RKEY = `${NAMESPACE}0007`;
const ALL_POST_IDS = [POST_RKEY, REPOST_RKEY, LIKED_POST_ID, PARENT_RKEY, ROOT_RKEY];

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

/** A post the projection will find already present, written the normal way. */
async function seedPost(
  id: string,
  oxyUserId: string,
  overrides: Partial<PostRecordInput> = {},
): Promise<PostRecord> {
  return insertPostRecord({
    id,
    oxyUserId,
    authorship: buildAuthorship(oxyUserId, []),
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'seeded' }] },
    ...overrides,
  });
}

/** The stored post, assembled exactly as hydration and the feed engine read it. */
function readPost(id: string): Promise<PostRecord | null> {
  return loadPostRecord(id);
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  // Default: no blob resolves (records without embeds are unaffected). Cases that
  // exercise the resolver override this.
  oxyMock.getServiceAssetMetadataBySha256.mockReset();
  oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([]);
});

afterEach(async () => {
  await db.delete(likes).where(inArray(likes.postId, ALL_POST_IDS));
  await db.delete(bookmarks).where(inArray(bookmarks.postId, ALL_POST_IDS));
  await db.delete(postRecentRepliers).where(inArray(postRecentRepliers.postId, ALL_POST_IDS));
  // Children cascade from `posts`; rows REFERENCING these ids go first.
  await db.delete(posts).where(inArray(posts.parentPostId, ALL_POST_IDS));
  await db.delete(posts).where(inArray(posts.boostOf, ALL_POST_IDS));
  await db.delete(posts).where(inArray(posts.id, ALL_POST_IDS));
});

describe('projectRecord — post', () => {
  const createdAtIso = '2024-01-02T03:04:05.000Z';
  const postRecord = {
    text: 'hello materialized world from the chain',
    createdAt: createdAtIso,
    tags: ['mtn', 'protocol'],
    langs: ['en'],
  };

  it('writes the parent row AND every child row a post needs to render', async () => {
    const result = await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));
    expect(result).toEqual({ ok: true, kind: 'post', id: POST_RKEY });

    const post = await readPost(POST_RKEY);
    expect(post).not.toBeNull();
    expect(post?.oxyUserId).toBe(SUBJECT_OXY_ID);
    expect(post?.type).toBe(PostType.TEXT);
    expect(post?.visibility).toBe(PostVisibility.PUBLIC);
    expect(post?.status).toBe('published');
    // The BODY — `post_content_variants`. Without this row the post renders empty
    // and every other assertion here still passes.
    expect(post?.content.variants?.[0]?.text).toBe(postRecord.text);
    expect(post?.content.variants?.[0]?.source).toBe('author');
    expect(post?.content.variants?.[0]?.tag).toBe('en');
    // The OWNER — `post_authorships`, the authority `oxy_user_id` projects.
    expect(post?.authorship).toEqual([
      { oxyUserId: SUBJECT_OXY_ID, role: 'owner', status: 'accepted' },
    ]);
    expect(post?.hashtags).toEqual(['mtn', 'protocol']);
    expect(post?.parentPostId).toBeNull();
    expect(post?.threadId).toBeNull();
    expect(post?.isReply).toBe(false);
    expect(post?.createdAt.toISOString()).toBe(createdAtIso);
  });

  it('writes a classification identical to the baseline classifier output', async () => {
    const expected = baselineContentClassifier.classify({
      text: postRecord.text,
      hashtags: postRecord.tags,
      language: postRecord.langs[0],
      languages: postRecord.langs,
    });

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));

    const post = await readPost(POST_RKEY);
    expect(post?.postClassification.status).toBe('pending');
    expect(post?.postClassification.attempts).toBe(0);
    expect(post?.postClassification.topics).toEqual(expected.topics);
    expect(post?.postClassification.languages).toEqual(expected.languages);
    expect(post?.postClassification.hashtagsNorm).toEqual(expected.hashtagsNorm);
    expect(post?.postClassification.scores).toEqual(expected.scores);
    expect(post?.postClassification.version).toBe(expected.version);
    // The top-level AP protocol field follows the resolved primary.
    expect(post?.language).toBe(expected.languages[0]);
  });

  it('converges on a second projection instead of duplicating anything', async () => {
    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));
    const first = await readPost(POST_RKEY);

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));
    const second = await readPost(POST_RKEY);

    expect(second?.content.variants).toEqual(first?.content.variants);
    expect(second?.authorship).toEqual(first?.authorship);
    expect(second?.postClassification.scores).toEqual(first?.postClassification.scores);
    // One rendition, not two — the content rewrite deletes before it inserts.
    expect(second?.content.variants).toHaveLength(1);
  });

  it('applies an edited body over the previous one', async () => {
    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));
    await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, { ...postRecord, text: 'the edited body' }),
    );

    const post = await readPost(POST_RKEY);
    expect(post?.content.variants).toHaveLength(1);
    expect(post?.content.variants?.[0]?.text).toBe('the edited body');
  });

  it('recovers reply context and links it when both ends are materialized', async () => {
    await seedPost(ROOT_RKEY, SUBJECT_OXY_ID);
    await seedPost(PARENT_RKEY, SUBJECT_OXY_ID);

    await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, {
        ...postRecord,
        reply: {
          root: createPostUri(SUBJECT_OXY_ID, ROOT_RKEY),
          parent: createPostUri(SUBJECT_OXY_ID, PARENT_RKEY),
        },
      }),
    );

    const post = await readPost(POST_RKEY);
    expect(post?.parentPostId).toBe(PARENT_RKEY);
    expect(post?.threadId).toBe(ROOT_RKEY);
    expect(post?.isReply).toBe(true);
    // The parent's recent-replier projection moved too, as for a native reply.
    const repliers = await db
      .select({ oxyUserId: postRecentRepliers.oxyUserId })
      .from(postRecentRepliers)
      .where(eq(postRecentRepliers.postId, PARENT_RKEY));
    expect(repliers.map((row) => row.oxyUserId)).toEqual([SUBJECT_OXY_ID]);
  });

  it('keeps an unlinkable reply OUT of the root feeds', async () => {
    // THE regression this guards. `parent_post_id` is a real foreign key, so a
    // reply whose parent is not materialized here cannot store the link — and if
    // `is_reply` were derived from that null link, the reply would be PROMOTED
    // into For You / Following / Explore, every one of which reads
    // `is_reply = false`.
    const result = await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, {
        ...postRecord,
        reply: {
          root: createPostUri(SUBJECT_OXY_ID, ROOT_RKEY),
          parent: createPostUri(SUBJECT_OXY_ID, PARENT_RKEY),
        },
      }),
    );

    expect(result).toEqual({ ok: true, kind: 'post', id: POST_RKEY });
    const post = await readPost(POST_RKEY);
    expect(post?.parentPostId).toBeNull();
    expect(post?.threadId).toBeNull();
    expect(post?.isReply).toBe(true);
  });

  it("REFUSES a record whose rkey is another user's post, leaving that post untouched", async () => {
    await seedPost(POST_RKEY, OWNER_OXY_ID, {
      content: { variants: [{ source: 'author', text: 'the victim body' }] },
    });

    const result = await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));

    expect(result).toEqual({ ok: false, reason: 'record_owner_mismatch' });
    const post = await readPost(POST_RKEY);
    expect(post?.oxyUserId).toBe(OWNER_OXY_ID);
    expect(post?.content.variants?.[0]?.text).toBe('the victim body');
    expect(post?.authorship[0]?.oxyUserId).toBe(OWNER_OXY_ID);
  });

  it('rejects an invalid inner record', async () => {
    const result = await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, { text: 42 }),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_record' });
    expect(await readPost(POST_RKEY)).toBeNull();
  });

  it('is a clear no-op for a non-parseable subject DID', async () => {
    const result = await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord, 'did:web:example.com:not-a-user'),
    );
    expect(result).toEqual({ ok: false, reason: 'unresolvable_subject_did' });
    expect(await readPost(POST_RKEY)).toBeNull();
  });
});

describe('projectRecord — the record owns some of the content, not all of it', () => {
  const postRecord = { text: 'a body', createdAt: '2024-01-02T03:04:05.000Z' };

  it('PRESERVES existing media when the record resolves none', async () => {
    await seedPost(POST_RKEY, SUBJECT_OXY_ID, {
      content: {
        variants: [{ source: 'author', text: 'seeded' }],
        media: [{ id: 'file-existing', type: 'image' }],
      },
    });

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));

    const post = await readPost(POST_RKEY);
    expect(post?.content.media).toEqual([{ id: 'file-existing', type: 'image' }]);
    expect(post?.content.variants?.[0]?.text).toBe('a body');
  });

  it("PRESERVES the post's @mention allowlist, which the record does not carry", async () => {
    await seedPost(POST_RKEY, SUBJECT_OXY_ID, { mentions: ['mentioned-user-a', 'mentioned-user-b'] });

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));

    const post = await readPost(POST_RKEY);
    expect([...(post?.mentions ?? [])].sort()).toEqual(['mentioned-user-a', 'mentioned-user-b']);
  });

  it('PRESERVES a collaborator, which the record does not carry either', async () => {
    // A post record names only its SUBJECT, so rewriting the authorship from it
    // revokes every collaborator on every re-projection — which is what the
    // Mongoose version did, and what `replacePostContent` deliberately refuses to
    // do for the same reason. Found by mutation-testing the refresh path: deleting
    // the authorship rewrite made nothing go red, because nothing had a
    // collaborator to lose.
    await seedPost(POST_RKEY, SUBJECT_OXY_ID, {
      authorship: [
        { oxyUserId: SUBJECT_OXY_ID, role: 'owner', status: 'accepted' },
        { oxyUserId: 'collaborator-1', role: 'collaborator', status: 'accepted' },
      ],
    });

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));

    const post = await readPost(POST_RKEY);
    expect(post?.authorship).toEqual([
      { oxyUserId: SUBJECT_OXY_ID, role: 'owner', status: 'accepted' },
      { oxyUserId: 'collaborator-1', role: 'collaborator', status: 'accepted' },
    ]);
    // …and the body still updated, so this is not passing by doing nothing.
    expect(post?.content.variants?.[0]?.text).toBe('a body');
  });

  it('PRESERVES an attached article, which the record does not carry', async () => {
    await seedPost(POST_RKEY, SUBJECT_OXY_ID, {
      content: {
        variants: [{ source: 'author', text: 'seeded' }],
        article: { articleId: 'article-1', title: 'A long read' },
      },
    });

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, postRecord));

    const post = await readPost(POST_RKEY);
    expect(post?.content.article?.articleId).toBe('article-1');
    expect(post?.content.article?.title).toBe('A long read');
  });

  it('writes the source links the record DOES carry', async () => {
    await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, {
        ...postRecord,
        sources: [{ url: 'https://example.com/a', title: 'A' }, { url: 'https://example.com/b' }],
      }),
    );

    const post = await readPost(POST_RKEY);
    expect(post?.content.sources).toEqual([
      { url: 'https://example.com/a', title: 'A' },
      { url: 'https://example.com/b' },
    ]);
  });

  it('writes the shared location as a coordinate pair', async () => {
    await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, {
        ...postRecord,
        location: { type: 'Point', coordinates: [2.1734, 41.3851] },
      }),
    );

    const post = await readPost(POST_RKEY);
    expect(post?.content.location?.coordinates).toEqual([2.1734, 41.3851]);
  });
});

describe('projectRecord — read-side blob resolution', () => {
  const SHA = 'a'.repeat(64);
  const withEmbed = {
    text: 'a post with media',
    createdAt: '2024-01-02T03:04:05.000Z',
    embed: { type: 'media', items: [{ blob: { sha256: SHA, mediaType: 'image' }, alt: 'alt text' }] },
  };

  it('turns a content address into a native fileId MediaItem', async () => {
    oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([
      { sha256: SHA, id: 'file-resolved', mime: 'image/jpeg', size: 1, status: 'active' },
    ]);

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, withEmbed));

    const post = await readPost(POST_RKEY);
    expect(post?.content.media).toEqual([{ id: 'file-resolved', type: 'image', alt: 'alt text' }]);
  });

  it('DROPS an unresolvable blob rather than inventing a URL', async () => {
    oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([]);

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, withEmbed));

    const post = await readPost(POST_RKEY);
    expect(post?.content.media ?? []).toEqual([]);
  });

  it('drops a trashed asset — only a live one is renderable', async () => {
    oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([
      { sha256: SHA, id: 'file-trashed', mime: 'image/jpeg', size: 1, status: 'trash' },
    ]);

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, withEmbed));

    const post = await readPost(POST_RKEY);
    expect(post?.content.media ?? []).toEqual([]);
  });

  it('never aborts the projection when the reverse lookup fails', async () => {
    oxyMock.getServiceAssetMetadataBySha256.mockRejectedValue(new Error('files:read scope missing'));

    const result = await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, withEmbed));

    expect(result).toEqual({ ok: true, kind: 'post', id: POST_RKEY });
    const post = await readPost(POST_RKEY);
    expect(post?.content.variants?.[0]?.text).toBe('a post with media');
    expect(post?.content.media ?? []).toEqual([]);
  });

  it('an empty resolution leaves an existing post its real media', async () => {
    await seedPost(POST_RKEY, SUBJECT_OXY_ID, {
      content: {
        variants: [{ source: 'author', text: 'seeded' }],
        media: [{ id: 'file-existing', type: 'image' }],
      },
    });
    oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([]);

    await projectRecord(envelope(MENTION_POST_COLLECTION, POST_RKEY, withEmbed));

    const post = await readPost(POST_RKEY);
    expect(post?.content.media).toEqual([{ id: 'file-existing', type: 'image' }]);
  });
});

describe('projectRecord — self-asserted createdAt is bounded', () => {
  async function projectWithCreatedAt(createdAt: unknown): Promise<Date | undefined> {
    await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, { text: 'a body', createdAt }),
    );
    return (await readPost(POST_RKEY))?.createdAt;
  }

  it('keeps a plausible past createdAt exactly as asserted', async () => {
    const stored = await projectWithCreatedAt('2024-01-02T03:04:05.000Z');
    expect(stored?.toISOString()).toBe('2024-01-02T03:04:05.000Z');
  });

  it('refuses a far-future createdAt instead of pinning the post atop every feed', async () => {
    const before = Date.now();
    const stored = await projectWithCreatedAt(new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString());
    expect(stored?.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored?.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('tolerates a small clock skew on the node that produced the record', async () => {
    const skewed = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const stored = await projectWithCreatedAt(skewed);
    expect(stored?.toISOString()).toBe(skewed);
  });

  it('projects a record whose createdAt is unparseable rather than failing it', async () => {
    const before = Date.now();
    const stored = await projectWithCreatedAt('banana');
    expect(stored?.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('projectRecord — like', () => {
  it('projects a like record into a real Like row against a real post', async () => {
    await seedPost(LIKED_POST_ID, OWNER_OXY_ID);

    const result = await projectRecord(
      envelope(MENTION_LIKE_COLLECTION, LIKE_RKEY, {
        subject: createPostUri(OWNER_OXY_ID, LIKED_POST_ID),
        createdAt: '2024-01-02T03:04:05.000Z',
      }),
    );

    expect(result).toEqual({ ok: true, kind: 'like', id: LIKE_RKEY });
    const rows = await db
      .select({ id: likes.id, userId: likes.userId, postId: likes.postId })
      .from(likes)
      .where(eq(likes.postId, LIKED_POST_ID));
    // The signed rkey IS the like's id — that is what lets the tombstone find it.
    expect(rows).toEqual([{ id: LIKE_RKEY, userId: SUBJECT_OXY_ID, postId: LIKED_POST_ID }]);
  });

  it('rejects a like whose subject URI is not an MTN URI', async () => {
    const result = await projectRecord(
      envelope(MENTION_LIKE_COLLECTION, LIKE_RKEY, {
        subject: 'https://example.com/notes/1',
        createdAt: '2024-01-02T03:04:05.000Z',
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'unresolvable_like_subject' });
  });
});

describe('projectRecord — repost', () => {
  const repostRecord = (subjectPostId: string) => ({
    subject: createPostUri(OWNER_OXY_ID, subjectPostId),
    createdAt: '2024-01-02T03:04:05.000Z',
  });

  it('projects a boost with an EMPTY body and a link to the original', async () => {
    await seedPost(LIKED_POST_ID, OWNER_OXY_ID);

    const result = await projectRecord(
      envelope(MENTION_REPOST_COLLECTION, REPOST_RKEY, repostRecord(LIKED_POST_ID)),
    );

    expect(result).toEqual({ ok: true, kind: 'repost', id: REPOST_RKEY });
    const boost = await readPost(REPOST_RKEY);
    expect(boost?.type).toBe(PostType.BOOST);
    expect(boost?.boostOf).toBe(LIKED_POST_ID);
    expect(boost?.oxyUserId).toBe(SUBJECT_OXY_ID);
    // NO rendition at all — a boost has nothing to say in any language, and the
    // hydration layer reads `boostOf` for what to show.
    expect(boost?.content.variants ?? []).toEqual([]);
    expect(boost?.authorship).toEqual([
      { oxyUserId: SUBJECT_OXY_ID, role: 'owner', status: 'accepted' },
    ]);
  });

  it('REFUSES a boost whose original is not materialized here', async () => {
    // `boost_of` is a foreign key and a boost that points at nothing renders as a
    // permanently blank card, so refusing keeps the projection re-runnable — the
    // boost lands the moment the original does.
    const result = await projectRecord(
      envelope(MENTION_REPOST_COLLECTION, REPOST_RKEY, repostRecord(LIKED_POST_ID)),
    );
    expect(result).toEqual({ ok: false, reason: 'unmaterialized_repost_subject' });
    expect(await readPost(REPOST_RKEY)).toBeNull();
  });

  it("REFUSES a repost whose rkey is another user's post", async () => {
    await seedPost(LIKED_POST_ID, OWNER_OXY_ID);
    await seedPost(REPOST_RKEY, OWNER_OXY_ID, {
      content: { variants: [{ source: 'author', text: 'the victim body' }] },
    });

    const result = await projectRecord(
      envelope(MENTION_REPOST_COLLECTION, REPOST_RKEY, repostRecord(LIKED_POST_ID)),
    );

    expect(result).toEqual({ ok: false, reason: 'record_owner_mismatch' });
    const victim = await readPost(REPOST_RKEY);
    expect(victim?.oxyUserId).toBe(OWNER_OXY_ID);
    expect(victim?.content.variants?.[0]?.text).toBe('the victim body');
  });

  it("refuses to rewrite one of the subject's OWN posts into a boost", async () => {
    await seedPost(LIKED_POST_ID, OWNER_OXY_ID);
    await seedPost(REPOST_RKEY, SUBJECT_OXY_ID, {
      content: { variants: [{ source: 'author', text: 'a real post' }] },
    });

    const result = await projectRecord(
      envelope(MENTION_REPOST_COLLECTION, REPOST_RKEY, repostRecord(LIKED_POST_ID)),
    );

    expect(result).toEqual({ ok: false, reason: 'repost_subject_mismatch' });
    expect((await readPost(REPOST_RKEY))?.type).toBe(PostType.TEXT);
  });
});

describe('projectRecord — bookmark', () => {
  it('projects a bookmark record into a real Bookmark row', async () => {
    await seedPost(LIKED_POST_ID, OWNER_OXY_ID);

    const result = await projectRecord(
      envelope(MENTION_BOOKMARK_COLLECTION, BOOKMARK_RKEY, {
        subject: createPostUri(OWNER_OXY_ID, LIKED_POST_ID),
        createdAt: '2024-01-02T03:04:05.000Z',
      }),
    );

    expect(result).toEqual({ ok: true, kind: 'bookmark', id: BOOKMARK_RKEY });
    const rows = await db
      .select({ id: bookmarks.id, userId: bookmarks.userId })
      .from(bookmarks)
      .where(eq(bookmarks.postId, LIKED_POST_ID));
    expect(rows).toEqual([{ id: BOOKMARK_RKEY, userId: SUBJECT_OXY_ID }]);
  });
});

describe('projectRecord — tombstone', () => {
  const tombstone = (subject: string) => ({ subject, createdAt: '2024-01-02T03:04:05.000Z' });

  it('removes the post and every child row with it', async () => {
    await seedPost(POST_RKEY, SUBJECT_OXY_ID, {
      content: {
        variants: [{ source: 'author', text: 'doomed' }],
        media: [{ id: 'file-1', type: 'image' }],
      },
      mentions: ['someone'],
    });

    const result = await projectRecord(
      envelope(
        MENTION_TOMBSTONE_COLLECTION,
        `${NAMESPACE}0008`,
        tombstone(createPostUri(SUBJECT_OXY_ID, POST_RKEY)),
      ),
    );

    expect(result).toEqual({ ok: true, kind: 'tombstone', id: POST_RKEY });
    expect(await readPost(POST_RKEY)).toBeNull();
  });

  it('removes the Like a like-subject tombstone names', async () => {
    await seedPost(LIKED_POST_ID, OWNER_OXY_ID);
    await projectRecord(
      envelope(MENTION_LIKE_COLLECTION, LIKE_RKEY, {
        subject: createPostUri(OWNER_OXY_ID, LIKED_POST_ID),
        createdAt: '2024-01-02T03:04:05.000Z',
      }),
    );

    await projectRecord(
      envelope(
        MENTION_TOMBSTONE_COLLECTION,
        `${NAMESPACE}0009`,
        tombstone(createLikeUri(SUBJECT_OXY_ID, LIKE_RKEY)),
      ),
    );

    const rows = await db.select({ id: likes.id }).from(likes).where(eq(likes.id, LIKE_RKEY));
    expect(rows).toEqual([]);
  });

  it('removes the Bookmark a bookmark-subject tombstone names', async () => {
    await seedPost(LIKED_POST_ID, OWNER_OXY_ID);
    await projectRecord(
      envelope(MENTION_BOOKMARK_COLLECTION, BOOKMARK_RKEY, {
        subject: createPostUri(OWNER_OXY_ID, LIKED_POST_ID),
        createdAt: '2024-01-02T03:04:05.000Z',
      }),
    );

    await projectRecord(
      envelope(
        MENTION_TOMBSTONE_COLLECTION,
        `${NAMESPACE}0010`,
        tombstone(createBookmarkUri(SUBJECT_OXY_ID, BOOKMARK_RKEY)),
      ),
    );

    const rows = await db.select({ id: bookmarks.id }).from(bookmarks).where(eq(bookmarks.id, BOOKMARK_RKEY));
    expect(rows).toEqual([]);
  });

  it('is idempotent: tombstoning an already-removed row is a no-op success', async () => {
    const result = await projectRecord(
      envelope(
        MENTION_TOMBSTONE_COLLECTION,
        `${NAMESPACE}0011`,
        tombstone(createPostUri(SUBJECT_OXY_ID, POST_RKEY)),
      ),
    );
    expect(result).toEqual({ ok: true, kind: 'tombstone', id: POST_RKEY });
  });

  it("REFUSES to delete another account's post", async () => {
    await seedPost(POST_RKEY, OWNER_OXY_ID);

    const result = await projectRecord(
      envelope(
        MENTION_TOMBSTONE_COLLECTION,
        `${NAMESPACE}0012`,
        tombstone(createPostUri(OWNER_OXY_ID, POST_RKEY)),
      ),
    );

    expect(result).toEqual({ ok: false, reason: 'tombstone_subject_owner_mismatch' });
    expect(await readPost(POST_RKEY)).not.toBeNull();
  });
});

describe('projectRecord — multilingual post (variants)', () => {
  const createdAtIso = '2024-01-02T03:04:05.000Z';

  it('materializes every rendition as an AUTHOR variant, in order', async () => {
    await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, {
        text: 'hola mundo',
        createdAt: createdAtIso,
        langs: ['es-ES', 'en-US'],
        variants: [
          { tag: 'es-ES', text: 'hola mundo' },
          { tag: 'en-US', text: 'hello world' },
        ],
      }),
    );

    const post = await readPost(POST_RKEY);
    // Everything on the chain is author-written — a machine translation is never
    // signed. `variants[0]` is the primary, and `position` in the table IS that
    // order, so a lost ordering shows up here rather than as a mystery later.
    expect(post?.content.variants).toEqual([
      { tag: 'es-ES', source: 'author', text: 'hola mundo', createdAt: createdAtIso },
      { tag: 'en-US', source: 'author', text: 'hello world', createdAt: createdAtIso },
    ]);
    // The top-level AP `language` is the BASE subtag — the alphabet the ranking
    // layer reads — even though the record's `langs` are regional.
    expect(post?.language).toBe('es');
  });

  it('re-keys a variant alt map from blob sha256 back to the live Oxy file id', async () => {
    oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([
      { sha256: 'sha-img', id: 'file-img', mime: 'image/png', size: 10, status: 'active' },
    ]);

    await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, {
        text: 'hola',
        createdAt: createdAtIso,
        langs: ['es'],
        embed: { type: 'media', items: [{ blob: { sha256: 'sha-img', mediaType: 'image' }, alt: 'un gato' }] },
        variants: [
          { tag: 'es', text: 'hola' },
          { tag: 'en', text: 'hi', alt: { 'sha-img': 'a cat' } },
        ],
      }),
    );

    const post = await readPost(POST_RKEY);
    // ONE batched reverse lookup covers the shared embed AND the variant alt keys.
    expect(oxyMock.getServiceAssetMetadataBySha256).toHaveBeenCalledTimes(1);
    expect(post?.content.media).toEqual([{ id: 'file-img', type: 'image', alt: 'un gato' }]);
    expect(post?.content.variants?.[1]?.alt).toEqual({ 'file-img': 'a cat' });
  });

  it('rebuilds the single rendition of a MONOLINGUAL record from text + langs', async () => {
    // The writer omits a one-entry `variants` array (it would just duplicate
    // `text`), so the reader reconstitutes it. This is also the DEGRADATION path:
    // a record written by a reader that never heard of `variants` still
    // materializes a complete, correctly-tagged post.
    await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, {
        text: 'hola',
        createdAt: createdAtIso,
        langs: ['es-ES'],
      }),
    );

    const post = await readPost(POST_RKEY);
    expect(post?.content.variants).toEqual([
      { tag: 'es-ES', source: 'author', text: 'hola', createdAt: createdAtIso },
    ]);
  });

  it('materializes an UNTAGGED rendition when the record declares no language', async () => {
    await projectRecord(
      envelope(MENTION_POST_COLLECTION, POST_RKEY, { text: '+1', createdAt: createdAtIso }),
    );

    const post = await readPost(POST_RKEY);
    expect(post?.content.variants).toEqual([
      { source: 'author', text: '+1', createdAt: createdAtIso },
    ]);
    expect(post?.content.variants?.[0]?.tag).toBeUndefined();
  });
});
