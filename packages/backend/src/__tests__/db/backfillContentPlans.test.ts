/**
 * `articles` and `post_recent_repliers`, copied by the REAL runner.
 *
 * The two are here for opposite reasons, and the cases follow that split.
 *
 * **`articles` is about fidelity.** The body of a long-form post is writing a
 * user cannot reproduce, and losing it fails silently at read time: the post
 * still renders with its title and an empty body, because the article is fetched
 * separately from the post naming it. So the article case asserts the stored
 * body BYTE FOR BYTE, including the leading and trailing whitespace Mongoose's
 * write-time `trim` did not apply to an already-stored value — a plan that
 * re-trimmed on the way past would be this migration editing prose.
 *
 * **`post_recent_repliers` is about the constraint.** Its content is a
 * self-healing projection, so wrong faces on a post are cosmetic; what is not
 * cosmetic is `unique(post_id, oxy_user_id)`, which Postgres adds over a Mongo
 * array that could name one user twice. That would abort a run with a `23505`
 * partway through, and no audit kind in this framework can predict it —
 * `UniquenessAudit` groups over DOCUMENTS and cannot see inside one document's
 * array. The dedupe is therefore load-bearing and is tested directly, including
 * that it keeps the NEWEST reply rather than whichever came last in the array.
 *
 * Fixtures are prefixed `bfc-` and every cleanup is scoped to them: vitest runs
 * test files in parallel against ONE Postgres database.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { asc, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { articles } from '../../db/schema/articles';
import { postRecentRepliers } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import {
  createResolutionContext,
  parentKeysFrom,
  type ParentKeys,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

/** Scoped to this file — see the header. */
const scope = postScope('bfc-content');
const AUTHOR = scope.user('author');

function planFor(collection: string) {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
}

/**
 * The `posts` rows the target holds, taken from the fixture.
 *
 * Declaring this is not optional any more: `posts` now carries orphan
 * resolutions, and `keysFor` REFUSES a table nobody loaded rather than
 * answering from an empty set — deciding a reference against the wrong parents
 * is the failure that contract exists to prevent. Reading the ids back out of
 * Mongo mirrors what the runner does (the parent set is what the copy has
 * already written) and cannot drift as fixtures change.
 */
async function postParents(): Promise<ParentKeys> {
  const rows = await mongo.collection('posts').find({}, { projection: { _id: 1 } }).toArray();
  return parentKeysFrom(new Map([['posts', new Set(rows.map((row) => String(row._id)))]]));
}

async function copy(collection: string) {
  const log = new ResolutionLog();
  return copyCollection(planFor(collection), {
    db: getDb(),
    source,
    resolutions: createResolutionContext(await planResolutions(source), log),
    parents: await postParents(),
  });
}

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_content_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  await getDb().delete(articles).where(eq(articles.createdBy, AUTHOR));
  // `post_recent_repliers` cascades from `posts`, which `clearPostScope` owns.
  await clearPostScope(scope);
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('articles', () => {
  it('copies the body verbatim, including whitespace it did not write', async () => {
    const id = new ObjectId();
    // Leading/trailing whitespace INSIDE the stored value: Mongoose's `trim`
    // applied on write, so a document written before that option — or by any
    // path that bypassed it — still holds this. Re-trimming here would change a
    // user's article, so the copy must not.
    const body = '  # A heading\n\nA paragraph with  spacing.  \n';
    await mongo.collection('articles').insertOne({
      _id: id,
      createdBy: AUTHOR,
      title: 'bfc title',
      body,
      createdAt: new Date('2024-02-03T04:05:06.007Z'),
      updatedAt: new Date('2024-02-03T04:05:06.007Z'),
    });

    await copy('articles');

    const [row] = await getDb()
      .select()
      .from(articles)
      .where(eq(articles.id, id.toHexString()));
    expect(row?.body).toBe(body);
    expect(row?.title).toBe('bfc title');
    expect(row?.createdAt?.toISOString()).toBe('2024-02-03T04:05:06.007Z');
  });

  it('keeps a draft article whose post does not exist yet as NULL, not a guess', async () => {
    const id = new ObjectId();
    await mongo.collection('articles').insertOne({
      _id: id,
      createdBy: AUTHOR,
      title: 'bfc draft',
      createdAt: new Date('2024-02-03T04:05:06.007Z'),
      updatedAt: new Date('2024-02-03T04:05:06.007Z'),
    });

    await copy('articles');

    const [row] = await getDb()
      .select()
      .from(articles)
      .where(eq(articles.id, id.toHexString()));
    // The Mongoose field is not `required`; NULL is a state, not a defect.
    expect(row?.postId).toBeNull();
    expect(row?.body).toBeNull();
  });

  it('treats an EMPTY postId as absent rather than as a reference to nothing', async () => {
    // `postId` is a bare indexed String in Mongo, so `''` is storable, and here
    // it is a real foreign key. Reading it with `str` would pass the empty
    // string to the constraint, which references no post and raises `23503`
    // partway through a run; `id` returns null for it. The distinction is one
    // helper name and the failure is at hour three, so it is worth a case.
    const id = new ObjectId();
    await mongo.collection('articles').insertOne({
      _id: id,
      postId: '',
      createdBy: AUTHOR,
      title: 'bfc empty link',
      createdAt: new Date('2024-02-03T04:05:06.007Z'),
      updatedAt: new Date('2024-02-03T04:05:06.007Z'),
    });

    await copy('articles');

    const [row] = await getDb()
      .select()
      .from(articles)
      .where(eq(articles.id, id.toHexString()));
    expect(row?.postId).toBeNull();
  });

  it('does NOT reconcile the denormalized shortcut on the post', async () => {
    // Mongo carried the linkage BOTH ways — `Article.postId` and
    // `Post.content.article.articleId` — and the two could disagree. The schema
    // settled which is authoritative (`articles.post_id`, the only side with a
    // constraint) but the migration must not act on that: quietly repairing a
    // disagreement destroys the evidence that one existed, and which side is
    // right is a question about the data rather than about the copy.
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    // Set on the ROW rather than through `seedPost`, because the denormalized
    // shortcut is not part of the post-creation input — which is itself the
    // point: nothing in the write path keeps the two sides agreeing, so they
    // can drift, and a document where they HAVE drifted is what this needs.
    await getDb()
      .update(posts)
      .set({ contentArticleId: 'bfc-other-article' })
      .where(eq(posts.id, post.id));
    const articleId = new ObjectId();
    await mongo.collection('articles').insertOne({
      _id: articleId,
      postId: post.id,
      createdBy: AUTHOR,
      title: 'bfc real',
      createdAt: new Date('2024-02-03T04:05:06.007Z'),
      updatedAt: new Date('2024-02-03T04:05:06.007Z'),
    });

    await copy('articles');

    const [row] = await getDb()
      .select()
      .from(articles)
      .where(eq(articles.id, articleId.toHexString()));
    const [stored] = await getDb().select().from(posts).where(eq(posts.id, post.id));

    expect(row?.postId).toBe(post.id);
    // Each side copied from its OWN source field; the disagreement survives.
    expect(stored?.contentArticleId).toBe('bfc-other-article');
  });
});

describe('post_recent_repliers', () => {
  async function seedProjection(entries: Array<{ oxyUserId: string; repliedAt: string }>) {
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    await mongo.collection('post_recent_repliers').insertOne({
      _id: new ObjectId(),
      postId: post.id,
      repliers: entries.map((entry) => ({
        oxyUserId: entry.oxyUserId,
        repliedAt: new Date(entry.repliedAt),
      })),
      createdAt: new Date('2024-05-06T07:08:09.010Z'),
      updatedAt: new Date('2024-05-06T07:08:09.010Z'),
    });
    return post;
  }

  async function repliersOf(postId: string) {
    return getDb()
      .select({ oxyUserId: postRecentRepliers.oxyUserId, repliedAt: postRecentRepliers.repliedAt })
      .from(postRecentRepliers)
      .where(eq(postRecentRepliers.postId, postId))
      .orderBy(asc(postRecentRepliers.repliedAt));
  }

  it('flattens one document into a row per replier', async () => {
    const post = await seedProjection([
      { oxyUserId: scope.user('r1'), repliedAt: '2024-01-01T00:00:00.000Z' },
      { oxyUserId: scope.user('r2'), repliedAt: '2024-01-02T00:00:00.000Z' },
      { oxyUserId: scope.user('r3'), repliedAt: '2024-01-03T00:00:00.000Z' },
    ]);

    await copy('post_recent_repliers');

    expect((await repliersOf(post.id)).map((row) => row.oxyUserId)).toEqual([
      scope.user('r1'),
      scope.user('r2'),
      scope.user('r3'),
    ]);
  });

  it('survives a document naming one user twice, keeping the NEWEST reply', async () => {
    // The `23505` case. Without the dedupe this insert aborts the run, which is
    // why the assertion is that the copy SUCCEEDS and which entry it kept —
    // asserting only "no error" would pass against a transform that dropped both.
    const twice = scope.user('twice');
    const post = await seedProjection([
      { oxyUserId: twice, repliedAt: '2024-01-01T00:00:00.000Z' },
      { oxyUserId: scope.user('other'), repliedAt: '2024-01-05T00:00:00.000Z' },
      { oxyUserId: twice, repliedAt: '2024-01-09T00:00:00.000Z' },
    ]);

    await copy('post_recent_repliers');

    const rows = await repliersOf(post.id);
    expect(rows).toHaveLength(2);
    const kept = rows.find((row) => row.oxyUserId === twice);
    expect(kept?.repliedAt.toISOString()).toBe('2024-01-09T00:00:00.000Z');
  });

  it('keeps the newest even when the array lists it FIRST', async () => {
    // The dedupe compares `repliedAt`, not array position. An implementation
    // that simply took the last entry per user would pass the case above and
    // fail this one, so the pair is what pins the rule.
    const twice = scope.user('reordered');
    const post = await seedProjection([
      { oxyUserId: twice, repliedAt: '2024-03-09T00:00:00.000Z' },
      { oxyUserId: twice, repliedAt: '2024-03-01T00:00:00.000Z' },
    ]);

    await copy('post_recent_repliers');

    const rows = await repliersOf(post.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.repliedAt.toISOString()).toBe('2024-03-09T00:00:00.000Z');
  });

  it('REFUSES an entry with no repliedAt rather than inventing one', async () => {
    // `replied_at` is NOT NULL with NO default, so unlike a timestamp column it
    // cannot fall through to a database value — but the reason to be loud is
    // stronger than the constraint: the read is ORDERED by this column, so an
    // invented `now()` would sort the entry straight to the top of the list it
    // is meant to describe.
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    await mongo.collection('post_recent_repliers').insertOne({
      _id: new ObjectId(),
      postId: post.id,
      repliers: [{ oxyUserId: scope.user('undated') }],
      createdAt: new Date('2024-05-06T07:08:09.010Z'),
      updatedAt: new Date('2024-05-06T07:08:09.010Z'),
    });

    await expect(copy('post_recent_repliers')).rejects.toThrow(/repliedAt/);
  });

  it('keeps the LIVE row when Postgres already holds that pair', async () => {
    // Distinct from the idempotence case below, and the distinction is the
    // whole reason this table is unusual: its Postgres side is ALREADY
    // authoritative (the projection services maintain it, the Mongo model is
    // write-dead), so this copy merges history into a table with LIVE writers.
    // Idempotence asks what a second copy of the SAME rows does; this asks what
    // happens when the live value DIFFERS from the historical one.
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    const replier = scope.user('live');
    await mongo.collection('post_recent_repliers').insertOne({
      _id: new ObjectId(),
      postId: post.id,
      repliers: [{ oxyUserId: replier, repliedAt: new Date('2020-01-01T00:00:00.000Z') }],
      createdAt: new Date('2024-05-06T07:08:09.010Z'),
      updatedAt: new Date('2024-05-06T07:08:09.010Z'),
    });

    const live = new Date('2026-01-01T00:00:00.000Z');
    await getDb()
      .insert(postRecentRepliers)
      .values({ postId: post.id, oxyUserId: replier, repliedAt: live });

    await copy('post_recent_repliers');

    const rows = await repliersOf(post.id);
    // `ON CONFLICT DO NOTHING` fires on the natural key, so the LIVE row and its
    // `replied_at` survive and the six-year-old historical one is skipped.
    // Nothing live is overwritten — which is what makes copying into a live
    // table the conservative choice rather than the reckless one.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.repliedAt.toISOString()).toBe(live.toISOString());
  });

  it('EMITS one row per surviving replier, which is what the verifier counts', async () => {
    // The subject the row-level cases above cannot see. Deleting the dedupe
    // leaves them green, because `ON CONFLICT DO NOTHING` collapses the
    // duplicate within the same statement anyway — measured, twice, on two
    // different plans. What the dedupe actually carries is the EMITTED count:
    // `verify.ts` re-runs the transforms to compute how many rows each table
    // should hold, so a transform emitting three rows into a table that can
    // hold two makes the verifier report a shortfall that is not one — a real
    // run failing its own check on healthy data.
    const twice = scope.user('counted');
    let emitted = 0;
    planFor('post_recent_repliers').transform(
      {
        _id: new ObjectId(),
        postId: new ObjectId().toHexString(),
        repliers: [
          { oxyUserId: twice, repliedAt: new Date('2024-01-03T00:00:00.000Z') },
          { oxyUserId: scope.user('counted-other'), repliedAt: new Date('2024-01-02T00:00:00.000Z') },
          { oxyUserId: twice, repliedAt: new Date('2024-01-01T00:00:00.000Z') },
        ],
      },
      () => {
        emitted += 1;
      },
      createResolutionContext(await planResolutions(source), new ResolutionLog())
    );

    expect(emitted).toBe(2);
  });

  it('is idempotent: a second copy adds nothing', async () => {
    // What makes this converge is the NATURAL key, not the derived row id:
    // `bulkLoad`'s `ON CONFLICT DO NOTHING` names no target, so it fires on
    // whichever unique constraint the duplicate hits first.
    const post = await seedProjection([
      { oxyUserId: scope.user('once'), repliedAt: '2024-04-01T00:00:00.000Z' },
    ]);

    await copy('post_recent_repliers');
    await copy('post_recent_repliers');

    expect(await repliersOf(post.id)).toHaveLength(1);
  });
});
