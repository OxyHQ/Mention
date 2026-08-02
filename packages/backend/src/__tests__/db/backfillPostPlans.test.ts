/**
 * The `posts` plan: one Mongo document → ten Postgres tables.
 *
 * The case that matters most is the COORDINATE ORDER. Mongo stores
 * `location.coordinates` as GeoJSON — `[longitude, latitude]`, longitude FIRST —
 * and the columns are `latitude` and `longitude` separately. Reading
 * `coordinates[0]` into `latitude` compiles, inserts, passes the range CHECK for
 * most of the populated world, and silently moves every located post to a
 * mirrored point. Nothing downstream errors: both values are numbers and the
 * generated `geography` is built from whatever pair it is given.
 *
 * So the fixture is deliberately asymmetric — a latitude that is NOT a valid
 * longitude would be caught by the range CHECK and is therefore a weaker test
 * than one where BOTH orderings are legal and only one is right. Barcelona
 * (41.39 N, 2.15 E) is exactly that: swapped, it is a legal point in the Gulf of
 * Guinea and every constraint still passes.
 *
 * `is_reply` is the second derived value with no Mongo counterpart, and it is
 * asserted in all three states — native parent, federated-only parent, neither.
 *
 * Fixtures are prefixed `bfx-` and every cleanup is SCOPED: vitest runs one
 * worker per file against ONE database.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import {
  postAttachments,
  postAuthorships,
  postClassificationTopicRefs,
  postContentVariants,
  postMedia,
  postMentions,
  postSources,
  postVariantAltTexts,
  postVariantMedia,
} from '../../db/schema/postContent';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import {
  createResolutionContext,
  parentKeysFrom,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

/** Scoped to this file — see the header. */
const OWNER = 'bfx-owner';
/** Barcelona. Swapped it is a legal point at sea, so only ORDER can tell. */
const LATITUDE = 41.3874;
const LONGITUDE = 2.1686;

const postsPlan = () => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === 'posts');
  if (!plan) throw new Error('no plan for posts');
  return plan;
};

async function copyPosts() {
  return copyCollection(postsPlan(), {
    db: getDb(),
    source,
    resolutions: createResolutionContext(await planResolutions(source), new ResolutionLog()),
    parents: parentKeysFrom(new Map()),
  });
}

/**
 * The minimum a `posts` document needs; `content` is required in Mongo.
 *
 * `visibility: 'private'` is NOT incidental. The feed engine's global discovery
 * lane scans `posts` for `public` + `published` rows with no author filter, and
 * `feedEngineParity.test.ts` asserts EXACT page membership — so a public row
 * inserted here, for the milliseconds a case holds it, joins that page and turns
 * a file nobody touched red. That is the fixture-ownership problem one level up
 * from a colliding id: the collision is in the row SHAPE a global query selects
 * on, not in a literal.
 *
 * Nothing in this file is about feed visibility, so `private` costs nothing.
 * The one property that genuinely needs the defaults — that an absent
 * `visibility` becomes `public` — is asserted against the TRANSFORM instead, so
 * it never reaches the shared table at all.
 */
function basePost(id: ObjectId, extra: Record<string, unknown> = {}) {
  return {
    _id: id,
    oxyUserId: OWNER,
    visibility: 'private',
    content: {},
    createdAt: new Date('2024-02-03T04:05:06.007Z'),
    updatedAt: new Date('2024-02-03T04:05:06.007Z'),
    ...extra,
  };
}

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_posts_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  // Every child table CASCADEs from `posts`.
  await getDb().delete(posts).where(eq(posts.oxyUserId, OWNER));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('the coordinate order', () => {
  it('reads GeoJSON [longitude, latitude] into the right columns', async () => {
    const id = new ObjectId();
    await mongo.collection('posts').insertOne(
      basePost(id, {
        // GeoJSON order: longitude FIRST.
        location: { type: 'Point', coordinates: [LONGITUDE, LATITUDE], address: 'bfx addr' },
        content: {
          location: { type: 'Point', coordinates: [LONGITUDE, LATITUDE], address: 'bfx c-addr' },
        },
      })
    );
    await copyPosts();

    const [row] = await getDb().select().from(posts).where(eq(posts.id, id.toHexString()));
    expect(row?.locationLatitude).toBe(LATITUDE);
    expect(row?.locationLongitude).toBe(LONGITUDE);
    expect(row?.contentLocationLatitude).toBe(LATITUDE);
    expect(row?.contentLocationLongitude).toBe(LONGITUDE);
    expect(row?.locationAddress).toBe('bfx addr');
    expect(row?.contentLocationAddress).toBe('bfx c-addr');
  });

  it('builds the generated geography from the same pair', async () => {
    const id = new ObjectId();
    await mongo.collection('posts').insertOne(
      basePost(id, { location: { type: 'Point', coordinates: [LONGITUDE, LATITUDE] } })
    );
    await copyPosts();

    // The end-to-end check: `geo` is GENERATED as
    // `ST_MakePoint(longitude, latitude)`, so reading it back and asking
    // PostGIS for X/Y proves the whole chain rather than just the two columns.
    const rows = await getDb().execute<{ x: number; y: number }>(sql`
      select ST_X(geo::geometry) as x, ST_Y(geo::geometry) as y
      from posts where id = ${id.toHexString()}
    `);
    expect(rows[0]?.x).toBeCloseTo(LONGITUDE, 6);
    expect(rows[0]?.y).toBeCloseTo(LATITUDE, 6);
  });

  it('nulls BOTH coordinates when the pair is incomplete', async () => {
    // `posts_location_pair_check` asserts all-or-nothing, and Mongo allowed an
    // empty array and half-written pairs — `outbox.service.ts` stripped those by
    // hand on the federated insert path. Anything that is not exactly two finite
    // numbers has to become NULL/NULL or the insert fails.
    const empty = new ObjectId();
    const half = new ObjectId();
    await mongo.collection('posts').insertMany([
      basePost(empty, { location: { coordinates: [] } }),
      basePost(half, { location: { coordinates: [LONGITUDE] } }),
    ]);
    await copyPosts();

    const rows = await getDb().select().from(posts).where(eq(posts.oxyUserId, OWNER));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.locationLatitude).toBeNull();
      expect(row.locationLongitude).toBeNull();
    }
  });
});

describe('the derived is_reply', () => {
  it('is true for a native reply, and the parent link survives', async () => {
    const parent = new ObjectId();
    const child = new ObjectId();
    await mongo
      .collection('posts')
      .insertMany([basePost(parent), basePost(child, { parentPostId: parent.toHexString() })]);
    await copyPosts();

    const [row] = await getDb().select().from(posts).where(eq(posts.id, child.toHexString()));
    expect(row?.isReply).toBe(true);
    // Filled by the runner's SECOND pass — a self-reference is inserted NULL and
    // updated once every row exists, because Postgres checks the key
    // immediately and a parent can sort after its child by `_id`.
    expect(row?.parentPostId).toBe(parent.toHexString());
  });

  it('is true for a federated reply whose parent was never imported', async () => {
    // The case a `parentPostId` test alone misses, and the reason
    // `utils/postReply.ts` asks the question as a disjunction.
    const id = new ObjectId();
    await mongo
      .collection('posts')
      .insertOne(basePost(id, { federation: { inReplyTo: 'https://bfx.example/notes/1' } }));
    await copyPosts();

    const [row] = await getDb().select().from(posts).where(eq(posts.id, id.toHexString()));
    expect(row?.isReply).toBe(true);
    expect(row?.parentPostId).toBeNull();
  });

  it('is false for a root post', async () => {
    const id = new ObjectId();
    await mongo.collection('posts').insertOne(basePost(id));
    await copyPosts();

    const [row] = await getDb().select().from(posts).where(eq(posts.id, id.toHexString()));
    expect(row?.isReply).toBe(false);
  });
});

describe('the child tables', () => {
  const mediaItem = {
    id: 'bfx-file-1',
    type: 'image',
    alt: 'bfx alt',
    width: 800,
    height: 600,
    orientation: 'landscape',
    aspectRatio: 1.3333,
    mime: 'image/webp',
  };

  async function seedRich(id: ObjectId): Promise<void> {
    await mongo.collection('posts').insertOne(
      basePost(id, {
        authorship: [
          { oxyUserId: OWNER, role: 'owner', status: 'accepted' },
          { oxyUserId: 'bfx-collab', role: 'collaborator', status: 'pending' },
        ],
        // Deliberately duplicated — the unique keys are `(post_id, oxy_user_id)`
        // and `(post_id, name)`, so a duplicate in the source is a `23505`
        // unless the transform dedupes.
        mentions: ['bfx-m1', 'bfx-m2', 'bfx-m1'],
        content: {
          variants: [
            {
              tag: 'en',
              source: 'author',
              text: 'bfx body',
              media: [mediaItem],
              alt: { 'bfx-file-1': 'bfx variant alt' },
              article: { title: 'bfx t', body: 'bfx b', excerpt: 'bfx e' },
            },
          ],
          media: [mediaItem],
          attachments: [
            { type: 'media', id: 'bfx-file-1', mediaType: 'image' },
            { type: 'poll' },
          ],
          sources: [{ url: 'https://bfx.example/a', title: 'bfx source' }],
        },
        postClassification: {
          topicRefs: [
            { name: 'bfx-topic', topicId: 'bfx-t1', relevance: 7, type: 'topic' },
            { name: 'bfx-topic' },
          ],
        },
      })
    );
  }

  it('fills all nine of them from one document', async () => {
    const id = new ObjectId();
    await seedRich(id);
    const result = await copyPosts();
    const postId = id.toHexString();
    const db = getDb();

    expect(result.documentsRead).toBe(1);

    const authorships = await db
      .select()
      .from(postAuthorships)
      .where(eq(postAuthorships.postId, postId));
    expect(authorships).toHaveLength(2);
    expect(authorships.map((row) => row.role).sort()).toStrictEqual(['collaborator', 'owner']);

    const variants = await db
      .select()
      .from(postContentVariants)
      .where(eq(postContentVariants.postId, postId));
    expect(variants).toHaveLength(1);
    // The Mongo field is `text`; the column is `body`.
    expect(variants[0]?.body).toBe('bfx body');
    expect(variants[0]?.position).toBe(0);
    expect(variants[0]?.articleTitle).toBe('bfx t');
    // GENERATED from `body` — naming it in the transform would throw.
    expect(variants[0]?.searchVector).toContain('bfx');

    const variantId = variants[0]?.id ?? '';
    expect(
      await db.select().from(postVariantMedia).where(eq(postVariantMedia.variantId, variantId))
    ).toHaveLength(1);

    const altTexts = await db
      .select()
      .from(postVariantAltTexts)
      .where(eq(postVariantAltTexts.variantId, variantId));
    // `alt` is a MAP, not an array — keyed by media id, so the row id derives
    // from the key rather than an ordinal.
    expect(altTexts).toHaveLength(1);
    expect(altTexts[0]?.mediaId).toBe('bfx-file-1');
    expect(altTexts[0]?.description).toBe('bfx variant alt');

    const media = await db.select().from(postMedia).where(eq(postMedia.postId, postId));
    expect(media).toHaveLength(1);
    expect(media[0]?.mediaId).toBe('bfx-file-1');
    expect(media[0]?.orientation).toBe('landscape');

    const attachments = await db
      .select()
      .from(postAttachments)
      .where(eq(postAttachments.postId, postId));
    expect(attachments).toHaveLength(2);
    // `id` is required only for `type: 'media'`, so it stays NULL otherwise.
    expect(attachments.find((row) => row.type === 'poll')?.attachmentId).toBeNull();

    expect(
      await db.select().from(postSources).where(eq(postSources.postId, postId))
    ).toHaveLength(1);

    const mentions = await db.select().from(postMentions).where(eq(postMentions.postId, postId));
    // Three in the source, two distinct — deduped rather than left to collide.
    expect(mentions.map((row) => row.oxyUserId).sort()).toStrictEqual(['bfx-m1', 'bfx-m2']);

    const topicRefs = await db
      .select()
      .from(postClassificationTopicRefs)
      .where(eq(postClassificationTopicRefs.postId, postId));
    expect(topicRefs).toHaveLength(1);
    expect(topicRefs[0]?.relevance).toBe(7);
  });

  /**
   * The dedup is invisible in the TABLE, because every insert is `ON CONFLICT
   * DO NOTHING` — measured: removing the guard leaves the row set identical.
   * What it protects is the verifier, which computes each child table's
   * expected count by re-running this transform. So the assertion has to be on
   * what the transform EMITS, not on what Postgres holds.
   */
  it('emits one row per DISTINCT mention, matching what the table can hold', async () => {
    const id = new ObjectId();
    await seedRich(id);
    const doc = await mongo.collection('posts').findOne({ _id: id });
    expect(doc).not.toBeNull();

    const emitted: string[] = [];
    postsPlan().transform(
      doc as unknown as Record<string, unknown>,
      (table, row) => {
        if (table === postMentions) emitted.push(String(row.oxyUserId));
      },
      createResolutionContext(await planResolutions(source), new ResolutionLog())
    );

    // Three in the source array, two distinct. Emitting three would make the
    // verifier's count comparison fail on every affected post, turning the
    // signal that means "the copy lost something" into routine noise.
    expect(emitted).toStrictEqual(['bfx-m1', 'bfx-m2']);
  });

  it('emits one row per DISTINCT topic ref, for the same reason', async () => {
    const id = new ObjectId();
    await seedRich(id);
    const doc = await mongo.collection('posts').findOne({ _id: id });

    const emitted: string[] = [];
    postsPlan().transform(
      doc as unknown as Record<string, unknown>,
      (table, row) => {
        if (table === postClassificationTopicRefs) emitted.push(String(row.name));
      },
      createResolutionContext(await planResolutions(source), new ResolutionLog())
    );

    expect(emitted).toStrictEqual(['bfx-topic']);
  });

  it('is idempotent across every table', async () => {
    const id = new ObjectId();
    await seedRich(id);
    await copyPosts();
    await copyPosts();
    const postId = id.toHexString();
    const db = getDb();

    // A non-deterministic child id would double every one of these.
    expect(await db.select().from(postAuthorships).where(eq(postAuthorships.postId, postId)))
      .toHaveLength(2);
    expect(await db.select().from(postMedia).where(eq(postMedia.postId, postId))).toHaveLength(1);
    expect(await db.select().from(postSources).where(eq(postSources.postId, postId)))
      .toHaveLength(1);
  });
});

describe('the scalar columns', () => {
  /**
   * Asserted against the TRANSFORM, not against a copied row, and deliberately:
   * a document with no `visibility` becomes `public` + `published`, which is
   * precisely the shape the feed engine's global discovery lane selects on. A
   * row of that shape in the shared table — even for the milliseconds one case
   * holds it — joins `feedEngineParity`'s exact-membership page and turns a file
   * nobody touched red. The property under test is what the transform produces,
   * so there is no reason to write it anywhere.
   */
  it('re-applies the Mongoose defaults an absent field would lose', async () => {
    const id = new ObjectId();
    const doc = {
      _id: id,
      oxyUserId: OWNER,
      content: {},
      createdAt: new Date('2024-02-03T04:05:06.007Z'),
      updatedAt: new Date('2024-02-03T04:05:06.007Z'),
    };

    let built: Record<string, unknown> | null = null;
    postsPlan().transform(
      doc as unknown as Record<string, unknown>,
      (table, row) => {
        if (table === posts) built = row;
      },
      createResolutionContext(await planResolutions(source), new ResolutionLog())
    );

    expect(built).not.toBeNull();
    const row = built as unknown as Record<string, unknown>;
    expect(row.createdAt).toStrictEqual(new Date('2024-02-03T04:05:06.007Z'));
    expect(row.type).toBe('text');
    expect(row.visibility).toBe('public');
    expect(row.status).toBe('published');
    expect(row.replyPermission).toStrictEqual(['anyone']);
    expect(row.classificationStatus).toBe('pending');
    expect(row.classificationSentiment).toBe('neutral');
    expect(row.statsLikesCount).toBe(0);
    // SPARSE in Mongo, so absent is NOT `false` — it stays NULL and only
    // curated posts enter the partial index.
    expect(row.curated).toBeNull();
  });

  it('flattens the nested content subdocuments', async () => {
    const id = new ObjectId();
    await mongo.collection('posts').insertOne(
      basePost(id, {
        content: {
          pollId: 'bfx-poll',
          article: { articleId: 'bfx-article', title: 'bfx at' },
          // A STRING in Mongo, a `timestamptz` here.
          event: { eventId: 'bfx-ev', date: '2025-06-07T08:09:10.011Z' },
          room: { roomId: 'bfx-room', status: 'live' },
          podcast: { syraPodcastId: 'bfx-pod' },
        },
      })
    );
    await copyPosts();

    const [row] = await getDb().select().from(posts).where(eq(posts.id, id.toHexString()));
    expect(row?.contentPollId).toBe('bfx-poll');
    expect(row?.contentArticleId).toBe('bfx-article');
    expect(row?.contentEventDate).toStrictEqual(new Date('2025-06-07T08:09:10.011Z'));
    expect(row?.contentRoomStatus).toBe('live');
    expect(row?.contentPodcastSyraId).toBe('bfx-pod');
  });
});

/**
 * Six posts of 577,526 in production have NO `createdAt` — absent, not
 * malformed. All six federated, five of them one batch, which points at the raw
 * federated `insertMany` path.
 *
 * The column is `NOT NULL` **with a DEFAULT**, so the silent outcome is `now()`:
 * they would be dated to the migration instant and sit at the top of every
 * chronological feed on day one, with nothing raised anywhere. That is the shape
 * of failure a defaulted column has, and it is why silence from an audit is not
 * evidence for this class.
 */
describe('a post with no createdAt', () => {
  it('takes the time from its own _id, not the migration clock', async () => {
    // A fixed second in 2023, so "derived from the id" and "whatever the clock
    // says" cannot be confused for one another.
    const createdSeconds = Math.floor(new Date('2023-05-06T07:08:09.000Z').getTime() / 1000);
    const id = ObjectId.createFromTime(createdSeconds);
    const startedAt = new Date();
    const document = basePost(id);
    // The production shape: the field is ABSENT, not null.
    delete (document as { createdAt?: unknown }).createdAt;
    await mongo.collection('posts').insertOne(document);
    await copyPosts();

    const [row] = await getDb().select().from(posts).where(eq(posts.id, id.toHexString()));

    expect(row?.createdAt).toStrictEqual(new Date(createdSeconds * 1000));
    // The assertion that would fail against the database default. Without it
    // this case passes on `now()` for any fixture whose id happens to be new.
    expect(row?.createdAt.getTime()).toBeLessThan(startedAt.getTime());
  });

  it('does NOT reach for updatedAt, which is two weeks late on the real rows', async () => {
    const createdSeconds = Math.floor(new Date('2026-06-27T05:49:29.000Z').getTime() / 1000);
    const id = ObjectId.createFromTime(createdSeconds);
    // The actual production value on five of the six: a media-cache rewrite a
    // fortnight after the post was written. It is the nearest plausible
    // alternative source and it is wrong in the direction that matters.
    const updatedAt = new Date('2026-07-13T21:26:55.109Z');
    const document = basePost(id, { updatedAt });
    delete (document as { createdAt?: unknown }).createdAt;
    await mongo.collection('posts').insertOne(document);
    await copyPosts();

    const [row] = await getDb().select().from(posts).where(eq(posts.id, id.toHexString()));

    expect(row?.createdAt).toStrictEqual(new Date(createdSeconds * 1000));
    expect(row?.createdAt).not.toStrictEqual(updatedAt);
    // `updatedAt` itself is still copied verbatim — the derivation replaces the
    // MISSING value, never a present one.
    expect(row?.updatedAt).toStrictEqual(updatedAt);
  });

  it('leaves a present createdAt alone, millisecond precision included', async () => {
    // The guard against always deriving: an ObjectId carries SECONDS, so a
    // transform that derived unconditionally would silently truncate the
    // millisecond component of every one of the 577,520 posts that have one.
    const id = new ObjectId();
    const createdAt = new Date('2024-02-03T04:05:06.007Z');
    await mongo.collection('posts').insertOne(basePost(id, { createdAt }));
    await copyPosts();

    const [row] = await getDb().select().from(posts).where(eq(posts.id, id.toHexString()));
    expect(row?.createdAt).toStrictEqual(createdAt);
    expect(row?.createdAt.getMilliseconds()).toBe(7);
  });
});
