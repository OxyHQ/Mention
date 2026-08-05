/**
 * A parent row lost to `ON CONFLICT DO NOTHING` must take its children with it.
 *
 * `copyRowsInto` inserts every table with `ON CONFLICT DO NOTHING`, and
 * `copyCollection` writes a plan's tables in foreign-key order on the strength of
 * one sentence: "the order already guarantees a parent lands before its child".
 * The order guarantees the parent's INSERT STATEMENT runs first. It does not
 * guarantee the parent ROW landed, and those come apart on exactly one input:
 *
 *   a source document whose row conflicts on a UNIQUE that is not the primary
 *   key, against a row already in the target under a DIFFERENT id.
 *
 * The parent is then skipped in silence while its children — built from the same
 * document, carrying the parent's source `_id` — are inserted against an id that
 * never entered the table. Postgres refuses them, and the run dies on the CHILD's
 * foreign key, naming a constraint that is not the problem.
 *
 * It is a property of the parent/child contract, not of one table. It has been
 * observed twice in production restores, on two unrelated pairs:
 * `post_authorships -> posts` (conflicting on `federation_activity_id`) and
 * `blocklist_proposal_observations -> blocklist_proposals`. So the cases below
 * cover both pairs, and the fix belongs in the runner rather than in a plan.
 *
 * ## Why this input is ordinary rather than exotic
 *
 * `assertTargetsEmpty` guards a COLD start, so the shape cannot arise there. The
 * RESUME path has no equivalent and is documented as supported — and a resume is
 * precisely the run whose target is not empty. Any restore over a target the live
 * application has written to since (a re-ingested federated post, a re-proposed
 * blocklist domain) meets it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { postAuthorships } from '../../db/schema/postContent';
import { blocklistProposals, blocklistProposalObservations } from '../../db/schema/blocklist';
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

/** Scoped to this file — vitest runs one worker per file against ONE database. */
const OWNER = 'bfconflict-owner';
const ACTIVITY_ID = 'https://remote.example/users/bfconflict/statuses/1#activity';
const SQUATTER_ID = 'bfconflict-squatter';
const DOMAIN = 'bfconflict.example';

async function copy(collection: string) {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  const ids = await mongo
    .collection(collection)
    .find({}, { projection: { _id: 1 } })
    .toArray();
  return copyCollection(plan, {
    db: getDb(),
    source,
    resolutions: createResolutionContext(await planResolutions(source), new ResolutionLog()),
    // The parent set the runner would have: what the copy has already written.
    parents: parentKeysFrom(
      new Map([['posts', new Set(ids.map((row) => String(row._id)))]]),
    ),
  });
}

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_conflicted_parents_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  const db = getDb();
  await db.delete(posts).where(eq(posts.oxyUserId, OWNER));
  await db.delete(posts).where(inArray(posts.id, [SQUATTER_ID]));
  await db.delete(blocklistProposals).where(eq(blocklistProposals.domain, DOMAIN));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await closePostgres();
  await mongod?.stop();
});

describe('a parent skipped by ON CONFLICT DO NOTHING drops its children', () => {
  /**
   * The production shape, verbatim: the live application re-ingested a federated
   * post after the target was truncated, so the target holds that post under a
   * NEW id while the restore carries the original one. `federation_activity_id`
   * is unique, so the restore's `posts` row is skipped — and its authorship row
   * points at the id that was skipped.
   *
   * Before the fix this throws
   * `post_authorships_post_id_posts_id_fk`, killing the whole run.
   */
  it('does not insert an authorship for a post that lost a federation_activity_id conflict', async () => {
    // Already in the target, under a DIFFERENT id, holding the unique value.
    await getDb().insert(posts).values({
      id: SQUATTER_ID,
      oxyUserId: OWNER,
      federationActivityId: ACTIVITY_ID,
      visibility: 'private',
    });

    const restoredId = new ObjectId();
    await mongo.collection('posts').insertOne({
      _id: restoredId,
      oxyUserId: OWNER,
      visibility: 'private',
      content: {},
      federation: { activityId: ACTIVITY_ID },
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
      createdAt: new Date('2024-02-03T04:05:06.007Z'),
      updatedAt: new Date('2024-02-03T04:05:06.007Z'),
    });

    await expect(copy('posts')).resolves.toBeDefined();

    // The parent really was refused — that is the premise, not the bug.
    const parent = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.id, String(restoredId)));
    expect(parent).toEqual([]);

    // And nothing was written pointing at it.
    const orphans = await getDb()
      .select({ id: postAuthorships.id })
      .from(postAuthorships)
      .where(eq(postAuthorships.postId, String(restoredId)));
    expect(orphans).toEqual([]);
  });

  /**
   * A post whose parent DID land keeps its children, in the same batch as one
   * whose parent did not. Without this the fix could pass by dropping every
   * child row, which would be a quieter version of the same data loss.
   */
  it('keeps the children of the posts that did land, in the same batch', async () => {
    await getDb().insert(posts).values({
      id: SQUATTER_ID,
      oxyUserId: OWNER,
      federationActivityId: ACTIVITY_ID,
      visibility: 'private',
    });

    const conflicted = new ObjectId();
    const clean = new ObjectId();
    await mongo.collection('posts').insertMany([
      {
        _id: conflicted,
        oxyUserId: OWNER,
        visibility: 'private',
        content: {},
        federation: { activityId: ACTIVITY_ID },
        authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
        createdAt: new Date('2024-02-03T04:05:06.007Z'),
        updatedAt: new Date('2024-02-03T04:05:06.007Z'),
      },
      {
        _id: clean,
        oxyUserId: OWNER,
        visibility: 'private',
        content: {},
        authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
        createdAt: new Date('2024-02-03T04:05:07.007Z'),
        updatedAt: new Date('2024-02-03T04:05:07.007Z'),
      },
    ]);

    await copy('posts');

    const kept = await getDb()
      .select({ postId: postAuthorships.postId })
      .from(postAuthorships)
      .where(eq(postAuthorships.postId, String(clean)));
    expect(kept).toHaveLength(1);

    const dropped = await getDb()
      .select({ postId: postAuthorships.postId })
      .from(postAuthorships)
      .where(eq(postAuthorships.postId, String(conflicted)));
    expect(dropped).toEqual([]);
  });

  /**
   * A RESUME must not lose anything. The parent is already in the target under
   * the SAME id — a primary-key conflict, so it is skipped too — and its children
   * are still legitimately insertable. This is what makes "the set of ids
   * INSERTED by this statement" the wrong answer and "the set of ids PRESENT in
   * the target" the right one: `RETURNING` yields nothing here, and filtering on
   * it would silently drop the children of every row a previous run wrote.
   */
  it('still writes children when the parent was already there under the same id', async () => {
    const resumed = new ObjectId();
    await getDb().insert(posts).values({
      id: String(resumed),
      oxyUserId: OWNER,
      visibility: 'private',
    });

    await mongo.collection('posts').insertOne({
      _id: resumed,
      oxyUserId: OWNER,
      visibility: 'private',
      content: {},
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
      createdAt: new Date('2024-02-03T04:05:06.007Z'),
      updatedAt: new Date('2024-02-03T04:05:06.007Z'),
    });

    await copy('posts');

    const kept = await getDb()
      .select({ postId: postAuthorships.postId })
      .from(postAuthorships)
      .where(eq(postAuthorships.postId, String(resumed)));
    expect(kept).toHaveLength(1);
  });

  /**
   * The SECOND pair, unrelated to posts, because the defect is the parent/child
   * contract and not one table. `blocklist_proposals` is unique on its domain,
   * so a re-proposed domain squats the value under a different id exactly as the
   * federated post did.
   */
  it('does not insert an observation for a proposal that lost a domain conflict', async () => {
    await getDb().insert(blocklistProposals).values({
      id: 'bfconflict-proposal-squatter',
      domain: DOMAIN,
      status: 'open',
      firstProposedAt: new Date('2024-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2024-01-02T00:00:00.000Z'),
      operatorCount: 1,
      corroboratingSources: ['squatter.example'],
      footprintActors: 0,
      footprintPosts: 0,
      footprintLocalUsersFollowing: 0,
      footprintRemoteActorsFollowed: 0,
      footprintLocalUsersFollowed: 0,
    });

    const restoredId = new ObjectId();
    await mongo.collection('blocklistproposals').insertOne({
      _id: restoredId,
      domain: DOMAIN,
      status: 'open',
      firstProposedAt: new Date('2024-02-03T04:05:06.007Z'),
      lastSeenAt: new Date('2024-02-03T04:05:06.007Z'),
      operatorCount: 1,
      corroboratingSources: ['restored.example'],
      footprint: {
        actors: 0,
        posts: 0,
        localUsersFollowing: 0,
        remoteActorsFollowed: 0,
        localUsersFollowed: 0,
      },
      observations: [
        {
          instance: 'restored.example',
          operator: 'restored-operator',
          severity: 'suspend',
          resolvedFromDigest: false,
        },
      ],
      createdAt: new Date('2024-02-03T04:05:06.007Z'),
      updatedAt: new Date('2024-02-03T04:05:06.007Z'),
    });

    await expect(copy('blocklistproposals')).resolves.toBeDefined();

    const orphans = await getDb()
      .select({ id: blocklistProposalObservations.id })
      .from(blocklistProposalObservations)
      .where(eq(blocklistProposalObservations.proposalId, String(restoredId)));
    expect(orphans).toEqual([]);
  });
});
