/**
 * The post storage layer, against a real database.
 *
 * Every assertion here is about a ROW, not about a query having been built —
 * that distinction is the whole reason this suite exists. The Mongoose suites it
 * replaces mocked the model and checked which arguments the service passed, so
 * they were green while the thing under them was wrong; the guard that shipped
 * broken in the sibling oxy-api port was exactly of that shape.
 *
 * Three guarantees are load-bearing and are each mutation-tested (break it, the
 * failure names it):
 *
 *  1. **A reply stays a reply when its parent is deleted.** `ON DELETE SET NULL`
 *     clears `parent_post_id`, so anything reading a null parent as "root"
 *     promotes an orphan into For You / Following / Explore. `is_reply` is the
 *     stored answer and the CHECK constraints keep it honest.
 *  2. **Authorship survives the round trip and is what `authoredBy` matches.**
 *     The correlated subquery in `authoredBy` is the exact shape that renders a
 *     bare column and silently returns nothing.
 *  3. **A post's content graph round-trips in ORDER** — `variants[0]` is the
 *     primary, and the media gallery keeps the author's arrangement.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import type { StoredPostContent } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { isCheckViolation, uuidv7 } from '@oxyhq/db';
import { posts } from '../../db/schema/posts';
import { postAuthorships, postContentVariants } from '../../db/schema/postContent';
import {
  authoredBy,
  CHRONO_DESC,
  countQuotesOf,
  deletePostRecord,
  findBoostedPostIds,
  findPostRecords,
  insertPostRecord,
  loadPostRecord,
  loadPostRecords,
  replacePostAuthorship,
  replacePostContent,
  updatePostRecord,
} from '../../db/posts/postRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';

let db: Database;
const created: string[] = [];

const AUTHOR = 'oxy-repo-author';
const COLLABORATOR = 'oxy-repo-collaborator';

/** A minimal valid post, with only the facts a caller must always state. */
function baseInput(overrides: Partial<PostRecordInput> = {}): PostRecordInput {
  return {
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'hello', tag: 'en' }] },
    ...overrides,
  };
}

async function create(overrides: Partial<PostRecordInput> = {}) {
  const record = await insertPostRecord(baseInput(overrides));
  created.push(record.id);
  return record;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  // Deepest-first so a parent's cascade cannot race a child's own delete.
  while (created.length > 0) {
    const id = created.pop();
    if (id) await db.delete(posts).where(eq(posts.id, id));
  }
  await db.delete(posts).where(eq(posts.oxyUserId, AUTHOR));
  await db.delete(posts).where(eq(posts.oxyUserId, COLLABORATOR));
});

afterAll(async () => {
  await closePostgres();
});

describe('the root-vs-reply discriminator', () => {
  /**
   * THE regression test for the `parent_post_id` escalation.
   *
   * The schema chose `ON DELETE SET NULL` over `CASCADE` because it loses no
   * rows — on the condition that root-feed membership stop being read off
   * `parent_post_id IS NULL`. This is that condition, asserted: delete the
   * parent and the orphan must still describe itself as a reply.
   *
   * Mutation: change `isReply: derivesReplyIntent(input)` in
   * `toPostInsert` to `isReply: false` and this goes red on the FIRST
   * assertion, naming the reply intent. Remove the stored column and read
   * `parentPostId == null` instead and it goes red on the last one.
   */
  it('keeps an orphaned reply classified as a reply after its parent is deleted', async () => {
    const parent = await create();
    const reply = await create({ parentPostId: parent.id, content: { variants: [{ source: 'author', text: 're' }] } });

    expect(reply.isReply).toBe(true);
    expect(reply.parentPostId).toBe(parent.id);

    await db.delete(posts).where(eq(posts.id, parent.id));

    const orphan = await loadPostRecord(reply.id);
    // `SET NULL` fired — the link is gone, which is the whole hazard.
    expect(orphan?.parentPostId).toBeNull();
    // …and the post is still, truthfully, a reply. This is what keeps it out of
    // the root feeds.
    expect(orphan?.isReply).toBe(true);
  });

  it('classifies a federated reply whose parent was never imported', async () => {
    /**
     * The second encoding. `federation.inReplyTo` is written at ingest and does
     * not depend on Mention holding the parent, so a post can be a reply with no
     * `parent_post_id` from the moment it is created. One column answers for both
     * encodings, which is why the query layer stops needing a disjunction.
     */
    const reply = await create({
      parentPostId: null,
      federation: {
        activityId: `https://remote.example/notes/${uuidv7()}`,
        inReplyTo: 'https://remote.example/notes/parent',
      },
    });

    expect(reply.parentPostId).toBeNull();
    expect(reply.isReply).toBe(true);
  });

  it('classifies an ordinary top-level post as a root', async () => {
    // The vacuity floor: if everything were a reply the tests above would pass
    // against a constant.
    const root = await create();
    expect(root.isReply).toBe(false);
  });

  it('refuses a row that has a parent and claims not to be a reply', async () => {
    /**
     * The constraint asserted directly, so the repository is not the only thing
     * standing between a future writer and a promoted orphan. A raw insert is
     * the shape that bypasses `insertPostRecord` — a backfill, a `psql` session,
     * a second service — and it is exactly the one the CHECK exists for.
     */
    const parent = await create();
    // The constraint NAME is asserted, not merely "it threw": a different
    // constraint firing would otherwise read as this one doing its job.
    // postgres.js carries the name on the driver error under drizzle's wrapper,
    // which is what `isCheckViolation` walks to.
    const rejection = await db
      .insert(posts)
      .values({ id: uuidv7(), oxyUserId: AUTHOR, parentPostId: parent.id, isReply: false })
      .then(() => null, (error: unknown) => error);
    expect(rejection).not.toBeNull();
    expect(isCheckViolation(rejection, 'posts_reply_discriminator_check')).toBe(true);
  });

  it('refuses a federated reply that claims not to be a reply', async () => {
    const rejection = await db
      .insert(posts)
      .values({
        id: uuidv7(),
        oxyUserId: AUTHOR,
        federationInReplyTo: 'https://remote.example/notes/parent',
        isReply: false,
      })
      .then(() => null, (error: unknown) => error);
    expect(rejection).not.toBeNull();
    expect(isCheckViolation(rejection, 'posts_federated_reply_discriminator_check')).toBe(true);
  });

  it('declares both discriminator CHECKs in the live database', async () => {
    /**
     * Read from `pg_constraint` rather than from the drizzle object: the schema
     * file could declare a constraint the migration never created and every
     * assertion made against the schema object would still pass while production
     * promoted orphans.
     */
    const rows = await db.execute<{ conname: string }>(sql`
      select con.conname
      from pg_constraint con
      where con.conrelid = 'posts'::regclass
        and con.contype = 'c'
        and con.conname like '%reply_discriminator%'
      order by con.conname
    `);
    expect([...rows].map((row) => row.conname)).toEqual([
      'posts_federated_reply_discriminator_check',
      'posts_reply_discriminator_check',
    ]);
  });
});

describe('authorship', () => {
  it('round-trips owner and collaborators in byline order', async () => {
    const record = await create({
      authorship: [
        { oxyUserId: AUTHOR, role: 'owner', status: 'accepted' },
        {
          oxyUserId: COLLABORATOR,
          role: 'collaborator',
          status: 'pending',
          invitedAt: '2026-01-02T03:04:05.000Z',
        },
      ],
    });

    expect(record.authorship).toEqual([
      { oxyUserId: AUTHOR, role: 'owner', status: 'accepted' },
      {
        oxyUserId: COLLABORATOR,
        role: 'collaborator',
        status: 'pending',
        invitedAt: '2026-01-02T03:04:05.000Z',
      },
    ]);
  });

  /**
   * The correlated-subquery trap, asserted on real rows.
   *
   * Mutation: drop `qualified(...)` from either side of
   * `authoredBy`'s `post_id = id` comparison and this goes red with zero rows —
   * the exact silent failure (an author feed that is simply empty, with no
   * error) that shipped in the sibling port.
   */
  it('matches a post by any accepted author, not just the denormalized owner', async () => {
    const owned = await create();
    const collaborated = await create({
      oxyUserId: AUTHOR,
      authorship: [
        { oxyUserId: AUTHOR, role: 'owner', status: 'accepted' },
        { oxyUserId: COLLABORATOR, role: 'collaborator', status: 'accepted' },
      ],
    });

    const byOwner = await findPostRecords(authoredBy(AUTHOR), { orderBy: CHRONO_DESC });
    expect(byOwner.map((record) => record.id).sort()).toEqual([owned.id, collaborated.id].sort());

    const byCollaborator = await findPostRecords(authoredBy(COLLABORATOR), { orderBy: CHRONO_DESC });
    expect(byCollaborator.map((record) => record.id)).toEqual([collaborated.id]);
  });

  it('excludes a collaborator who has not accepted', async () => {
    await create({
      authorship: [
        { oxyUserId: AUTHOR, role: 'owner', status: 'accepted' },
        { oxyUserId: COLLABORATOR, role: 'collaborator', status: 'pending' },
      ],
    });
    expect(await findPostRecords(authoredBy(COLLABORATOR), { orderBy: CHRONO_DESC })).toEqual([]);
  });

  it('refuses a second owner on one post', async () => {
    // The invariant `getOwnerId` has always assumed and Mongo could not state.
    const record = await create();
    await expect(
      db.insert(postAuthorships).values({
        postId: record.id,
        oxyUserId: COLLABORATOR,
        role: 'owner',
        status: 'accepted',
      }),
    ).rejects.toThrow();
  });

  it('keeps the denormalized owner in step when authorship is replaced', async () => {
    const record = await create();
    await replacePostAuthorship(record.id, [
      { oxyUserId: COLLABORATOR, role: 'owner', status: 'accepted' },
    ]);
    const reloaded = await loadPostRecord(record.id);
    expect(reloaded?.oxyUserId).toBe(COLLABORATOR);
    expect(reloaded?.authorship).toEqual([
      { oxyUserId: COLLABORATOR, role: 'owner', status: 'accepted' },
    ]);
  });
});

describe('the content graph', () => {
  const richContent: StoredPostContent = {
    variants: [
      {
        tag: 'en',
        source: 'author',
        text: 'primary body',
        alt: { 'media-a': 'a cat' },
      },
      {
        tag: 'es',
        source: 'author',
        text: 'cuerpo',
        media: [{ id: 'media-es', type: 'image', alt: 'un gato' }],
        article: { title: 'Titulo', body: 'Cuerpo largo', excerpt: 'Resumen' },
      },
      { tag: 'de', source: 'machine', text: 'koerper' },
    ],
    media: [
      { id: 'media-a', type: 'image', width: 800, height: 600, orientation: 'landscape' },
      { id: 'media-b', type: 'video', durationSec: 12.5, mime: 'video/mp4' },
    ],
    attachments: [
      { type: 'media', id: 'media-a', mediaType: 'image' },
      { type: 'sources' },
    ],
    sources: [
      { url: 'https://example.com/one', title: 'One' },
      { url: 'https://example.com/two' },
    ],
    article: { articleId: 'article-1', title: 'Title', excerpt: 'Excerpt' },
    pollId: 'poll-1',
    event: { eventId: 'e1', name: 'Launch', date: '2026-03-01T10:00:00.000Z', location: 'Barcelona' },
    room: { roomId: 'r1', title: 'Room', status: 'live', topic: 'Topic', host: 'host' },
    podcast: { syraPodcastId: 'p1', title: 'Show', author: 'Host', showUrl: 'https://syra.fm/p1' },
    location: { type: 'Point', coordinates: [2.1734, 41.3851], address: 'Barcelona' },
  };

  it('round-trips every rendition, in order, with variant overrides intact', async () => {
    const record = await create({
      content: richContent,
      mentions: ['oxy-mentioned-1', 'oxy-mentioned-2'],
    });
    const reloaded = await loadPostRecord(record.id);
    const content = reloaded?.content;

    // `variants[0]` is the PRIMARY and the only home of the body. Position is
    // that order, so a lost `order by position` reorders what federates and what
    // gets signed onto the MTN chain.
    expect(content?.variants?.map((variant) => variant.tag)).toEqual(['en', 'es', 'de']);
    expect(content?.variants?.[0]).toMatchObject({ tag: 'en', source: 'author', text: 'primary body' });
    expect(content?.variants?.[0].alt).toEqual({ 'media-a': 'a cat' });
    expect(content?.variants?.[1]).toMatchObject({ tag: 'es', source: 'author' });
    expect(content?.variants?.[1].media).toEqual([{ id: 'media-es', type: 'image', alt: 'un gato' }]);
    expect(content?.variants?.[1].article).toEqual({
      title: 'Titulo',
      body: 'Cuerpo largo',
      excerpt: 'Resumen',
    });
    expect(content?.variants?.[2]).toMatchObject({ tag: 'de', source: 'machine' });
  });

  it('round-trips the shared media set in gallery order', async () => {
    const record = await create({ content: richContent });
    const reloaded = await loadPostRecord(record.id);
    expect(reloaded?.content.media).toEqual([
      { id: 'media-a', type: 'image', width: 800, height: 600, orientation: 'landscape' },
      { id: 'media-b', type: 'video', durationSec: 12.5, mime: 'video/mp4' },
    ]);
  });

  it('round-trips attachments, sources, mentions and the scalar leaves', async () => {
    const record = await create({
      content: richContent,
      mentions: ['oxy-mentioned-1', 'oxy-mentioned-2'],
    });
    const reloaded = await loadPostRecord(record.id);

    expect(reloaded?.content.attachments).toEqual([
      { type: 'media', id: 'media-a', mediaType: 'image' },
      { type: 'sources' },
    ]);
    expect(reloaded?.content.sources).toEqual([
      { url: 'https://example.com/one', title: 'One' },
      { url: 'https://example.com/two' },
    ]);
    expect(reloaded?.mentions.sort()).toEqual(['oxy-mentioned-1', 'oxy-mentioned-2']);
    expect(reloaded?.content.article).toEqual({
      articleId: 'article-1',
      title: 'Title',
      excerpt: 'Excerpt',
    });
    expect(reloaded?.content.pollId).toBe('poll-1');
    expect(reloaded?.content.event).toEqual({
      eventId: 'e1',
      name: 'Launch',
      date: '2026-03-01T10:00:00.000Z',
      location: 'Barcelona',
    });
    expect(reloaded?.content.room).toEqual({
      roomId: 'r1',
      title: 'Room',
      status: 'live',
      topic: 'Topic',
      host: 'host',
    });
    expect(reloaded?.content.podcast).toEqual({
      syraPodcastId: 'p1',
      title: 'Show',
      author: 'Host',
      showUrl: 'https://syra.fm/p1',
    });
  });

  it('stores a location as [longitude, latitude] and generates the matching point', async () => {
    /**
     * The ordering is checked against an independently knowable fact rather than
     * against itself: Barcelona is at ~2.17E, ~41.39N, so a transposed pair
     * would plot at 41.39E / 2.17N — off the coast of Somalia. `ST_X` reading
     * the longitude is what proves the writer and the generated column agree.
     */
    const record = await create({ content: richContent });
    const reloaded = await loadPostRecord(record.id);
    expect(reloaded?.content.location).toEqual({
      type: 'Point',
      coordinates: [2.1734, 41.3851],
      address: 'Barcelona',
    });

    const [geo] = await db
      .select({
        lon: sql<number>`ST_X(${posts.contentGeo}::geometry)`,
        lat: sql<number>`ST_Y(${posts.contentGeo}::geometry)`,
      })
      .from(posts)
      .where(eq(posts.id, record.id));
    expect(geo.lon).toBeCloseTo(2.1734, 4);
    expect(geo.lat).toBeCloseTo(41.3851, 4);
  });

  it('replaces the whole content graph on an edit without touching authorship', async () => {
    const record = await create({
      content: richContent,
      mentions: ['oxy-mentioned-1'],
      authorship: [
        { oxyUserId: AUTHOR, role: 'owner', status: 'accepted' },
        { oxyUserId: COLLABORATOR, role: 'collaborator', status: 'accepted' },
      ],
    });

    await replacePostContent(
      record.id,
      { variants: [{ tag: 'fr', source: 'author', text: 'nouveau' }] },
      ['oxy-mentioned-9'],
    );

    const reloaded = await loadPostRecord(record.id);
    expect(reloaded?.content.variants).toEqual([{ tag: 'fr', source: 'author', text: 'nouveau' }]);
    expect(reloaded?.content.media).toBeUndefined();
    expect(reloaded?.content.sources).toBeUndefined();
    expect(reloaded?.mentions).toEqual(['oxy-mentioned-9']);
    // An edit must never revoke a collaborator.
    expect(reloaded?.authorship).toHaveLength(2);
  });

  it('is atomic: a rejected child row leaves no post behind', async () => {
    /**
     * `post_content_variants` is unique on `(post_id, tag)` where the tag is not
     * null, so two `en` renditions is a constraint violation raised AFTER the
     * `posts` row has been inserted. Without one transaction that leaves an
     * authorless, bodyless post no feed can find and no ACL can evaluate.
     */
    const id = uuidv7();
    await expect(
      insertPostRecord(
        baseInput({
          id,
          content: {
            variants: [
              { tag: 'en', source: 'author', text: 'one' },
              { tag: 'en', source: 'author', text: 'two' },
            ],
          },
        }),
      ),
    ).rejects.toThrow();

    expect(await loadPostRecord(id)).toBeNull();
  });
});

describe('reads the rest of the port depends on', () => {
  it('returns records in the order the caller asked for, skipping missing ids', async () => {
    const first = await create();
    const second = await create();
    const records = await loadPostRecords([second.id, 'no-such-post', first.id]);
    expect(records.map((record) => record.id)).toEqual([second.id, first.id]);
  });

  it('counts quotes per post in one aggregate', async () => {
    const target = await create();
    const other = await create();
    await create({ quoteOf: target.id, type: PostType.QUOTE });
    await create({ quoteOf: target.id, type: PostType.QUOTE });

    const counts = await countQuotesOf([target.id, other.id]);
    expect(counts.get(target.id)).toBe(2);
    // A post with no quotes is ABSENT, and the caller reads a miss as zero —
    // never as "not counted".
    expect(counts.has(other.id)).toBe(false);
  });

  it('reports which posts the viewer boosted', async () => {
    const original = await create();
    const untouched = await create();
    await create({
      oxyUserId: COLLABORATOR,
      authorship: [{ oxyUserId: COLLABORATOR, role: 'owner', status: 'accepted' }],
      boostOf: original.id,
      type: PostType.BOOST,
      content: { variants: [] },
    });

    const boosted = await findBoostedPostIds(COLLABORATOR, [original.id, untouched.id]);
    expect([...boosted]).toEqual([original.id]);
    expect(await findBoostedPostIds(AUTHOR, [original.id])).toEqual(new Set());
  });

  it('cascades a boost away with its original and spares a quote', async () => {
    const original = await create();
    const boost = await create({ boostOf: original.id, type: PostType.BOOST, content: { variants: [] } });
    const quote = await create({ quoteOf: original.id, type: PostType.QUOTE });

    await db.delete(posts).where(eq(posts.id, original.id));

    // A boost has an intentionally empty body — with the original gone it can
    // never render anything, so it goes too.
    expect(await loadPostRecord(boost.id)).toBeNull();
    // A quote has a body of its own and must outlive its subject.
    const survivingQuote = await loadPostRecord(quote.id);
    expect(survivingQuote?.quoteOf).toBeNull();
  });
});

describe('writes', () => {
  it('merges a metadata patch instead of replacing the subdocument', async () => {
    /**
     * The Mongo counterpart was a dotted `$set`, and a dot path handed to
     * drizzle's `set()` is an unknown property that drizzle silently IGNORES —
     * the write does nothing and throws nothing. This asserts the merge on real
     * columns: flipping the federation flag must not clear the pin.
     */
    const record = await create({ metadata: { isPinned: true, isSensitive: true } });
    await updatePostRecord(record.id, { metadata: { federationDelivered: true } });

    const reloaded = await loadPostRecord(record.id);
    expect(reloaded?.metadata.federationDelivered).toBe(true);
    expect(reloaded?.metadata.isPinned).toBe(true);
    expect(reloaded?.metadata.isSensitive).toBe(true);
  });

  it('persists the collaborative-federation lifecycle flags', async () => {
    // Both were absent from the first schema pass. They decide whether a post
    // fans out to the fediverse, so an absent column is a leaked invitee or a
    // double delivery — not a cosmetic gap.
    const record = await create({ metadata: { collabFederationDeferred: true } });
    expect(record.metadata.collabFederationDeferred).toBe(true);
    expect(record.metadata.federationDelivered).toBe(false);
  });

  it('preserves a pre-cutover ObjectId hex verbatim', async () => {
    const objectIdHex = 'a1b2c3d4e5f60718293a4b5c';
    const record = await create({ id: objectIdHex });
    expect(record.id).toBe(objectIdHex);
    expect((await loadPostRecord(objectIdHex))?.id).toBe(objectIdHex);
  });

  it('returns the deleted record so the caller can still tombstone it', async () => {
    const record = await create({ content: { variants: [{ source: 'author', text: 'bye' }] } });
    const deleted = await deletePostRecord(record.id, eq(posts.oxyUserId, AUTHOR));
    expect(deleted?.id).toBe(record.id);
    expect(deleted?.oxyUserId).toBe(AUTHOR);
    expect(await loadPostRecord(record.id)).toBeNull();
  });

  it('refuses to delete a post the ownership predicate does not match', async () => {
    const record = await create();
    const deleted = await deletePostRecord(record.id, eq(posts.oxyUserId, COLLABORATOR));
    expect(deleted).toBeNull();
    expect(await loadPostRecord(record.id)).not.toBeNull();
  });

  it('deletes the child rows of a post with it', async () => {
    const record = await create({
      content: { variants: [{ tag: 'en', source: 'author', text: 'x' }] },
    });
    await db.delete(posts).where(eq(posts.id, record.id));
    const remaining = await db
      .select({ id: postContentVariants.id })
      .from(postContentVariants)
      .where(eq(postContentVariants.postId, record.id));
    expect(remaining).toEqual([]);
  });

  it('applies the classification subdocument as columns', async () => {
    const record = await create({
      postClassification: {
        status: 'classified',
        attempts: 2,
        topics: ['tech', 'ai'],
        languages: ['en', 'es'],
        region: 'ES',
        sensitive: false,
        version: 7,
        sentiment: 'positive',
        intent: 'announcement',
        confidence: 0.82,
        scores: {
          toxicity: 0.01,
          constructiveness: 0.9,
          spam: 0.02,
          quality: 0.88,
          controversy: 0.1,
          negativity: 0.05,
        },
        topicRefs: [{ name: 'ai', topicId: 'topic-ai', relevance: 9, type: 'topic' }],
      },
    });

    const reloaded = await loadPostRecord(record.id);
    expect(reloaded?.postClassification).toMatchObject({
      status: 'classified',
      attempts: 2,
      topics: ['tech', 'ai'],
      languages: ['en', 'es'],
      region: 'ES',
      version: 7,
      sentiment: 'positive',
      intent: 'announcement',
      confidence: 0.82,
    });
    expect(reloaded?.postClassification.scores.quality).toBeCloseTo(0.88, 6);
    expect(reloaded?.postClassification.topicRefs).toEqual([
      { name: 'ai', topicId: 'topic-ai', relevance: 9, type: 'topic' },
    ]);
  });

  it('omits an absent optional rather than sending null', async () => {
    /**
     * Drizzle hands `null` where Mongoose handed `undefined`, and the shared
     * contract OMITS an absent optional — the SDK's zod parse rejects a null
     * where it expects the key to be missing. This is that conversion, asserted
     * on the keys most likely to be absent.
     */
    const record = await create({ content: { variants: [{ source: 'author', text: 'plain' }] } });
    const reloaded = await loadPostRecord(record.id);

    expect(reloaded).not.toBeNull();
    expect('language' in (reloaded ?? {})).toBe(false);
    expect('federation' in (reloaded ?? {})).toBe(false);
    expect('location' in (reloaded ?? {})).toBe(false);
    expect(reloaded?.content.media).toBeUndefined();
    expect('tag' in (reloaded?.content.variants?.[0] ?? {})).toBe(false);
  });

  it('keeps a federated post distinguishable from a native one', async () => {
    const native = await create();
    const federated = await create({
      federation: {
        activityId: `https://remote.example/notes/${uuidv7()}`,
        actorUri: 'https://remote.example/users/bob',
        url: 'https://remote.example/@bob/1',
        sensitive: true,
        spoilerText: 'cw',
      },
    });

    expect(native.federation).toBeUndefined();
    expect(federated.federation).toEqual({
      activityId: expect.stringContaining('https://remote.example/notes/'),
      actorUri: 'https://remote.example/users/bob',
      url: 'https://remote.example/@bob/1',
      sensitive: true,
      spoilerText: 'cw',
    });
    // The CW label also reaches `metadata`, which is where every renderer looks.
    expect(federated.metadata.spoilerText).toBe('cw');
  });

  it('refuses a duplicate federated activity id', async () => {
    const activityId = `https://remote.example/notes/${uuidv7()}`;
    await create({ federation: { activityId } });
    await expect(create({ federation: { activityId } })).rejects.toThrow();
  });
});

describe('list reads', () => {
  it('pages newest-first on a keyset both of whose columns are NOT NULL', async () => {
    /**
     * Mongo sorts missing values FIRST and Postgres sorts NULLs LAST, so a sort
     * key that can be null silently reverses which end of the range a bounded
     * sweep reaches. `created_at` and `id` are both `NOT NULL`, which is what
     * makes this ordering safe without a `nulls first`.
     */
    const older = await create({ createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const newer = await create({ createdAt: new Date('2026-02-01T00:00:00.000Z') });

    const page = await findPostRecords(
      and(eq(posts.oxyUserId, AUTHOR), eq(posts.status, 'published')),
      { orderBy: CHRONO_DESC, limit: 10 },
    );
    expect(page.map((record) => record.id)).toEqual([newer.id, older.id]);
  });
});
