/**
 * A checkpoint whose `kind` does not describe the collection must FAIL, not
 * silently select nothing.
 *
 * This reproduces a production cutover failure exactly. `engagement_outbox` (25
 * documents) and `moderation_outbox` (1) key their documents by a
 * caller-supplied STRING (`plans/timestamps.ts` names both), and both were given
 * a hand-written `objectId` checkpoint while another collection was being
 * rewound. MongoDB orders BSON types before values and **String sorts before
 * ObjectId**, so `{_id: {$gt: ObjectId("000…0")}}` matched no document at all.
 *
 * The copy then did the worst possible thing: it read zero, reached the end of
 * its sweep, marked the collection COMPLETE and exited 0 — with every row still
 * in the source. The only symptom was a source/target count somebody compared
 * by hand.
 *
 * ## What was already right, and what was missing
 *
 * `checkpointOf` and `reviveCheckpoint` handle both id kinds correctly; the
 * consuming code was never the problem, and checking it was what made this
 * defect look ruled out. The gap is that nothing verified the kind it was
 * HANDED against the collection it was about to filter — "can it do this?"
 * against "is what it was given coherent?".
 *
 * The check is local to the source: one sampled `_id`, no target query.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  CheckpointKindMismatchError,
  mongoSourceFromDb,
  streamCollection,
  type MongoSource,
} from '../../db/backfill/mongoSource';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

/** The shape of a real `engagement_outbox` key. */
const STRING_IDS = [
  'engagement:post.unsave:6a6e8db8cf216b1a1a9885e3:v2',
  'engagement:post.save:6a6e8db8cf216b1a1a9885e4:v1',
];

/** The value a hand-rewound checkpoint was set to in production. */
const ZERO_OBJECT_ID = '000000000000000000000000';

async function drain(name: string, after?: { value: string; kind: 'objectId' | 'string' }) {
  const documents: unknown[] = [];
  for await (const batch of streamCollection(source, name, 100, after)) {
    documents.push(...batch);
  }
  return documents;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_checkpoint_kind_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await mongod?.stop();
});

describe('a checkpoint whose kind does not match the collection', () => {
  /**
   * THE case, and the production failure verbatim.
   *
   * Mutation: remove the kind check from `streamCollection` and this stops
   * throwing — it returns an EMPTY array instead, which is precisely the silent
   * failure being guarded. So the assertion is on the throw, and the case below
   * pins the empty-read consequence separately.
   */
  it('refuses an objectId checkpoint over a string-keyed collection', async () => {
    await mongo.collection('engagement_outbox').insertMany(
      STRING_IDS.map((id) => ({ _id: id, kind: 'post.save' })) as never,
    );

    await expect(
      drain('engagement_outbox', { value: ZERO_OBJECT_ID, kind: 'objectId' }),
    ).rejects.toThrow(CheckpointKindMismatchError);
  });

  /**
   * The consequence the refusal exists to prevent, asserted directly against
   * MongoDB rather than described: the cross-type filter really does select
   * nothing. Without this the test above could pass against a check that
   * refuses something harmless.
   */
  it('would otherwise read ZERO of the documents that are there', async () => {
    await mongo.collection('engagement_outbox').insertMany(
      STRING_IDS.map((id) => ({ _id: id, kind: 'post.save' })) as never,
    );

    // The filter `streamCollection` would have built, issued directly.
    const selected = await mongo
      .collection('engagement_outbox')
      .find({ _id: { $gt: new ObjectId(ZERO_OBJECT_ID) } } as never)
      .toArray();
    const present = await mongo.collection('engagement_outbox').countDocuments({});

    expect(present).toBe(2);
    expect(selected).toHaveLength(0);
  });

  /** The matching kind still resumes, so the guard has not simply broken resume. */
  it('resumes normally when the kind matches', async () => {
    await mongo.collection('engagement_outbox').insertMany(
      STRING_IDS.map((id) => ({ _id: id, kind: 'post.save' })) as never,
    );

    const documents = await drain('engagement_outbox', {
      value: 'engagement:post.save:6a6e8db8cf216b1a1a9885e4:v1',
      kind: 'string',
    });
    expect(documents).toHaveLength(1);
  });

  /** And an ObjectId collection with an ObjectId checkpoint is untouched. */
  it('leaves an ObjectId-keyed collection alone', async () => {
    const older = new ObjectId('6a3480c3cd38eea5e9312c6a');
    const newer = new ObjectId();
    await mongo.collection('posts').insertMany([{ _id: older }, { _id: newer }] as never);

    const documents = await drain('posts', { value: older.toHexString(), kind: 'objectId' });
    expect(documents).toHaveLength(1);
  });

  /**
   * An EMPTY collection cannot hide anything behind a mismatched checkpoint, so
   * refusing there would be a false alarm on a legitimately empty source — and a
   * gate that cries wolf gets removed by whoever hits it next.
   */
  it('does not refuse when the collection is empty', async () => {
    await expect(
      drain('never_written', { value: ZERO_OBJECT_ID, kind: 'objectId' }),
    ).resolves.toEqual([]);
  });
});
