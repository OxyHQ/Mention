/**
 * The four orphan resolutions — the answer to the first production audit.
 *
 * Every blocking finding run 8 reported points at `posts.id`:
 * `post_recent_repliers.post_id` 457, `posts.boost_of` 347,
 * `posts.parent_post_id` 459, `posts.thread_id` 379. None is a schema defect —
 * they are references to posts Mention never held, overwhelmingly federated,
 * where a reply or an Announce arrived for an original that was never fetched.
 *
 * Three rules, because the remedy differs by what the column can hold and by
 * what the row is worth without it. The tests are written around the two ways
 * this can go wrong, which are opposites:
 *
 *  1. the rule does not fire, and the copy still breaks;
 *  2. the rule fires TOO WIDELY, and deletes rows nobody asked it to.
 *
 * (2) is the one that costs data, so it gets the most cases: a boost whose
 * target EXISTS must survive untouched, and an empty parent set must stand the
 * whole thing down rather than treat "no parents loaded" as "no parents exist".
 *
 * Fixtures are `bor-` prefixed; every id is scoped to this file.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq, inArray } from 'drizzle-orm';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { copyCollection } from '../../db/backfill/runner';
import { auditDefaultedColumns } from '../../db/backfill/audit';
import { auditReferentialIntegrity } from '../../db/backfill/referentialIntegrity';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { postRecentRepliers } from '../../db/schema/postContent';
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

const OWNER = 'bor-owner-1';

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

/**
 * Copy one collection, declaring which `posts` rows Postgres already holds.
 *
 * The parent set is the whole subject here: a resolution fires only for a value
 * ABSENT from it, so what this argument contains decides what the rules see.
 */
async function copy(collection: string, knownPostIds: readonly string[]) {
  const log = new ResolutionLog();
  const result = await copyCollection(planFor(collection), {
    db: getDb(),
    source,
    resolutions: createResolutionContext(await planResolutions(source), log),
    parents: parentKeysFrom(new Map([['posts', new Set(knownPostIds)]])),
  });
  return { result, log };
}

const basePost = (id: ObjectId, extra: Record<string, unknown> = {}) => ({
  _id: id,
  oxyUserId: OWNER,
  visibility: 'private',
  content: {},
  createdAt: new Date('2024-02-03T04:05:06.007Z'),
  updatedAt: new Date('2024-02-03T04:05:06.007Z'),
  ...extra,
});

/** Every document id this rule reported, across its records. */
const reportedIds = (log: ResolutionLog, ruleId: string): string[] => {
  const summary = log.summary().find((entry) => entry.rule.id === ruleId);
  return summary === undefined ? [] : [...summary.documentIds];
};

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_orphan_resolutions_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
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

describe('a reply and thread link naming a post Mention never held', () => {
  it('is NULLED, and the post itself is kept', async () => {
    const orphan = new ObjectId();
    const missing = new ObjectId();
    // A post that DOES exist, so the parent set is non-empty. That is not
    // decoration: an empty set stands every rule down (see the last case in
    // this file), so a fixture that omits it measures the rule not running.
    const decoy = new ObjectId();
    await mongo.collection('posts').insertMany([
      basePost(decoy),
      basePost(orphan, {
        parentPostId: missing.toHexString(),
        threadId: missing.toHexString(),
        content: { text: 'bor reply body' },
      }),
    ]);

    const { log } = await copy('posts', [decoy.toHexString()]);

    const [row] = await getDb().select().from(posts).where(eq(posts.id, orphan.toHexString()));

    // Kept — the whole point. It is somebody's writing; only the pointer was
    // missing. `visibility` is asserted rather than the body because a post's
    // text lives in `post_content_variants`, not on `posts`: it proves the row
    // is the real post and not a stub.
    expect(row).toBeDefined();
    expect(row?.visibility).toBe('private');
    expect(row?.parentPostId).toBeNull();
    expect(row?.threadId).toBeNull();

    // And it does not stop being a reply: `isReply` is derived while the row is
    // BUILT, before this rule runs on it.
    expect(row?.isReply).toBe(true);

    expect(reportedIds(log, 'null-link-to-a-post-mention-never-held')).toContain(
      orphan.toHexString()
    );
  });

  it('leaves a link whose target EXISTS completely alone', async () => {
    const parent = new ObjectId();
    const child = new ObjectId();
    await mongo
      .collection('posts')
      .insertMany([
        basePost(parent),
        basePost(child, {
          parentPostId: parent.toHexString(),
          threadId: parent.toHexString(),
        }),
      ]);

    const { log } = await copy('posts', [parent.toHexString()]);

    const [row] = await getDb().select().from(posts).where(eq(posts.id, child.toHexString()));
    expect(row?.parentPostId).toBe(parent.toHexString());
    expect(row?.threadId).toBe(parent.toHexString());
    expect(reportedIds(log, 'null-link-to-a-post-mention-never-held')).toStrictEqual([]);
  });
});

describe('a boost of a post Mention never held', () => {
  it('DROPS the boost row and reports its id', async () => {
    const boost = new ObjectId();
    const missing = new ObjectId();
    const decoy = new ObjectId();
    await mongo
      .collection('posts')
      .insertMany([basePost(decoy), basePost(boost, { type: 'boost', boostOf: missing.toHexString() })]);

    const { log } = await copy('posts', [decoy.toHexString()]);

    const rows = await getDb().select().from(posts).where(eq(posts.id, boost.toHexString()));
    expect(rows).toStrictEqual([]);

    // "Report every dropped id" is the ruling, and it is the reason the rule
    // records each document rather than only counting them.
    expect(reportedIds(log, 'drop-boost-of-a-post-mention-never-held')).toStrictEqual([
      boost.toHexString(),
    ]);
  });

  it('drops one that did not EXIST when the resolutions were planned', async () => {
    // "Report every dropped id" has to be a runtime output of the COPY, never a
    // list frozen from an audit — measured: an orphan boost appeared in
    // production 81 seconds after run 8's bound closed. A rule that consulted a
    // precomputed id list would copy that row and violate the foreign key,
    // having reported nothing.
    //
    // So the pre-pass is deliberately run FIRST, against a source that does not
    // yet contain the offending document.
    const decoy = new ObjectId();
    await mongo.collection('posts').insertOne(basePost(decoy));
    const planned = await planResolutions(source);
    // The ordering IS the fixture: if the offending document were already
    // present here, the test would pass without saying anything about frozen
    // lists.
    expect(await source.count('posts')).toBe(1);

    const late = new ObjectId();
    await mongo
      .collection('posts')
      .insertOne(basePost(late, { type: 'boost', boostOf: new ObjectId().toHexString() }));

    const log = new ResolutionLog();
    await copyCollection(planFor('posts'), {
      db: getDb(),
      source,
      resolutions: createResolutionContext(planned, log),
      parents: parentKeysFrom(new Map([['posts', new Set([decoy.toHexString()])]])),
    });

    const rows = await getDb().select().from(posts).where(eq(posts.id, late.toHexString()));
    expect(rows).toStrictEqual([]);
    expect(reportedIds(log, 'drop-boost-of-a-post-mention-never-held')).toStrictEqual([
      late.toHexString(),
    ]);
  });

  it('leaves a boost whose target EXISTS completely alone', async () => {
    const original = new ObjectId();
    const boost = new ObjectId();
    await mongo
      .collection('posts')
      .insertMany([
        basePost(original),
        basePost(boost, { type: 'boost', boostOf: original.toHexString() }),
      ]);

    const { log } = await copy('posts', [original.toHexString()]);

    const [row] = await getDb().select().from(posts).where(eq(posts.id, boost.toHexString()));
    expect(row).toBeDefined();
    expect(row?.boostOf).toBe(original.toHexString());
    expect(reportedIds(log, 'drop-boost-of-a-post-mention-never-held')).toStrictEqual([]);
  });

  it('REFUSES the run when no parent set was loaded at all', async () => {
    // The failure this guards is the expensive one, and the two shapes are a
    // keystroke apart at the call site: "no parents were loaded" and "no
    // parents exist" both look like an absent key. Reading the first as the
    // second would drop every boost in the database, so it throws instead —
    // and that is strictly better than the standing-down I first assumed it
    // did, which is why this asserts the refusal rather than survival.
    const boost = new ObjectId();
    await mongo
      .collection('posts')
      .insertOne(basePost(boost, { type: 'boost', boostOf: new ObjectId().toHexString() }));

    await expect(
      copyCollection(planFor('posts'), {
        db: getDb(),
        source,
        resolutions: createResolutionContext(await planResolutions(source), new ResolutionLog()),
        parents: parentKeysFrom(new Map()),
      })
    ).rejects.toThrow(/No parent keys were loaded for posts/);
  });

  it('stands DOWN for a loaded-but-empty parent set, and fails LOUDLY instead', async () => {
    // The other half of the same distinction. An empty set is a real answer
    // ("this table holds no rows yet"), and a rule that fired on it would drop
    // every boost during the first level of a copy — so it stands down.
    //
    // What it does INSTEAD is the point of this case: the copy then hits the
    // foreign key for real and stops. That is the correct trade for a
    // destructive rule, and it is why this asserts a 23503 rather than a
    // surviving row: standing down cannot be observed as silence, only as a
    // loud failure. (It is also not a state a real run reaches — `posts` is
    // self-referencing, so pass A has already populated the parent set by the
    // time pass B fills the links.)
    const boost = new ObjectId();
    await mongo
      .collection('posts')
      .insertOne(basePost(boost, { type: 'boost', boostOf: new ObjectId().toHexString() }));

    const failure = await copyCollection(planFor('posts'), {
      db: getDb(),
      source,
      resolutions: createResolutionContext(await planResolutions(source), new ResolutionLog()),
      parents: parentKeysFrom(new Map([['posts', new Set<string>()]])),
    }).then(
      () => null,
      (error: unknown) => error
    );

    // The constraint name is on the CAUSE, not the message — drizzle wraps the
    // driver error in a "Failed query" of its own, so matching the message
    // alone would pass for any failed statement including one that proved
    // nothing about the foreign key.
    expect(failure).toBeInstanceOf(Error);
    const cause = failure instanceof Error ? failure.cause : undefined;
    expect(String(cause)).toContain('posts_boost_of_posts_id_fk');
  });
});

describe('a recent-replier row naming a post Mention never held', () => {
  it('DROPS the row, and keeps the one whose post exists', async () => {
    const present = new ObjectId();
    const missing = new ObjectId();
    await mongo.collection('posts').insertOne(basePost(present));
    await mongo.collection('post_recent_repliers').insertMany([
      {
        _id: new ObjectId(),
        postId: present.toHexString(),
        repliers: [{ oxyUserId: 'bor-replier-1', repliedAt: new Date('2024-05-01T00:00:00.000Z') }],
      },
      {
        _id: new ObjectId(),
        postId: missing.toHexString(),
        repliers: [{ oxyUserId: 'bor-replier-2', repliedAt: new Date('2024-05-02T00:00:00.000Z') }],
      },
    ]);

    await copy('posts', [present.toHexString()]);
    const { log } = await copy('post_recent_repliers', [present.toHexString()]);

    const kept = await getDb()
      .select()
      .from(postRecentRepliers)
      .where(inArray(postRecentRepliers.postId, [present.toHexString(), missing.toHexString()]));

    expect(kept.map((row) => row.postId)).toStrictEqual([present.toHexString()]);
    expect(reportedIds(log, 'drop-recent-replier-of-a-vanished-post')).toHaveLength(1);
  });
});

describe('the audit passes that run transforms but decide no reference', () => {
  /**
   * The regression that reached PRODUCTION, and the reason this file exists in
   * the shape it does.
   *
   * `auditDefaultedColumns` runs every transform to measure which columns rows
   * omit. It decides no reference, so it had always passed an UNLOADED parent
   * set — correct, and inert, for exactly as long as `ORPHAN_RESOLUTIONS` was
   * empty: `resolveOrphanedReferences` returned before ever calling `keysFor`.
   *
   * Declaring the first resolution on `posts` woke that path up, and run 9 died
   * two minutes in with `MissingParentKeysError` before reaching a single
   * finding. The full test suite was green — 600 tests — because nothing
   * exercised an audit pass over a collection that HAS resolutions declared.
   * A rule can therefore be correct in every test and still stop the run.
   */
  it('run over a collection that HAS declared resolutions, without refusing', async () => {
    const boost = new ObjectId();
    await mongo
      .collection('posts')
      .insertMany([
        basePost(new ObjectId()),
        basePost(boost, { type: 'boost', boostOf: new ObjectId().toHexString() }),
      ]);

    const resolutions = createResolutionContext(await planResolutions(source), new ResolutionLog());

    // Both passes, because both run transforms for a non-reference purpose and
    // both used to pass an unloaded set.
    await expect(auditDefaultedColumns(source, planFor('posts'), resolutions)).resolves.toBeInstanceOf(
      Array
    );
    await expect(
      auditReferentialIntegrity(
        getDb(),
        source,
        [{ plan: planFor('posts'), documents: 2 }],
        resolutions
      )
    ).resolves.toBeDefined();
  });
});
