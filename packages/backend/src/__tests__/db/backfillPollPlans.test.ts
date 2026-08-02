/**
 * Poll votes keep their order across the migration — asserted through the REAL
 * consumer, not a re-implementation of its ORDER BY.
 *
 * Mongo stored `options[].votes` as a `[String]` that `$push` appended to, so
 * the array index is the only record of the sequence votes arrived in.
 * `PollVoteService.loadPollRecord` reads it back with
 * `orderBy(asc(createdAt), asc(id))` and says as much in its own comment. Both
 * of those sort keys are DERIVED by the backfill, because the source has
 * neither a timestamp nor an id per vote — so if either derivation ignores the
 * ordinal, the order is silently scrambled and nothing errors.
 *
 * Two ways it was scrambled before this was written, and both are covered:
 *
 * - `created_at` omitted → the column default applies, and `now()` is
 *   `transaction_timestamp()`, so every vote in ONE batched transaction shares a
 *   value to the microsecond and the primary sort key is a total tie.
 * - the id from `childRowId` → a sha256 digest, so the tiebreak sorted in HASH
 *   order.
 *
 * The cases below therefore assert through `loadPollRecord` itself. A test that
 * issued its own `order by` would be checking a query this file wrote rather
 * than the one the application runs, which is the failure it exists to catch.
 *
 * Fixtures are prefixed `bfp-` and every cleanup is SCOPED to them: vitest runs
 * one worker per file against ONE database.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { pollOptions, pollVotes, polls } from '../../db/schema/polls';
import { loadPollRecord } from '../../services/PollVoteService';
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
const OWNER = 'bfp-owner';
const POLL_CREATED_AT = new Date('2023-04-05T06:07:08.009Z');

const pollsPlan = () => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === 'polls');
  if (!plan) throw new Error('no plan for polls');
  return plan;
};

async function copyPolls() {
  const log = new ResolutionLog();
  return copyCollection(pollsPlan(), {
    db: getDb(),
    source,
    resolutions: createResolutionContext(await planResolutions(source), log),
    parents: parentKeysFrom(new Map()),
  });
}

/**
 * A poll whose votes are in a KNOWN, deliberately non-alphabetical order.
 *
 * The voter ids are chosen so that sorting them by any property other than the
 * array ordinal — alphabetically, or by the hash of a derived id — produces a
 * different sequence. An order that happened to be alphabetical would pass
 * against a completely broken derivation.
 */
async function seedPoll(id: ObjectId, createdAt: Date | null): Promise<string[]> {
  const first = ['bfp-zeta', 'bfp-alpha', 'bfp-mike', 'bfp-bravo'];
  const second = ['bfp-yankee', 'bfp-charlie'];
  await mongo.collection('polls').insertOne({
    _id: id,
    question: 'bfp question?',
    createdBy: OWNER,
    endsAt: new Date('2030-01-01T00:00:00.000Z'),
    options: [
      { _id: new ObjectId(), text: 'bfp option one', votes: first },
      { _id: new ObjectId(), text: 'bfp option two', votes: second },
    ],
    ...(createdAt === null ? {} : { created_at: createdAt, updated_at: createdAt }),
  });
  return [...first, ...second];
}

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_polls_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  // `poll_options` and `poll_votes` both CASCADE from `polls`.
  await getDb().delete(polls).where(eq(polls.createdBy, OWNER));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('vote order survives the copy', () => {
  it('reads back in $push order through the real consumer', async () => {
    const id = new ObjectId();
    await seedPoll(id, POLL_CREATED_AT);
    await copyPolls();

    const record = await loadPollRecord(getDb(), id.toHexString());
    expect(record).not.toBeNull();
    // Per OPTION, because that is the only order a caller can observe —
    // `loadPollRecord` buckets the flat ordered list by option immediately.
    expect(record?.options[0]?.votes).toStrictEqual([
      'bfp-zeta',
      'bfp-alpha',
      'bfp-mike',
      'bfp-bravo',
    ]);
    expect(record?.options[1]?.votes).toStrictEqual(['bfp-yankee', 'bfp-charlie']);
  });

  /**
   * The case that isolates the ID from the timestamp. With no `created_at` on
   * the poll there is no base to offset from, every vote ties on the primary
   * sort key, and the derived id is the ONLY thing carrying the order.
   */
  it('keeps the order with no poll timestamp at all, on the id alone', async () => {
    const id = new ObjectId();
    await seedPoll(id, null);
    await copyPolls();

    const rows = await getDb()
      .select({ createdAt: pollVotes.createdAt })
      .from(pollVotes)
      .where(eq(pollVotes.pollId, id.toHexString()));
    // Every row took the column default in one transaction, so the primary sort
    // key really is a tie — the premise this case depends on.
    expect(new Set(rows.map((row) => row.createdAt.getTime())).size).toBe(1);

    const record = await loadPollRecord(getDb(), id.toHexString());
    expect(record?.options[0]?.votes).toStrictEqual([
      'bfp-zeta',
      'bfp-alpha',
      'bfp-mike',
      'bfp-bravo',
    ]);
  });

  it('derives a strictly increasing created_at from the poll’s own', async () => {
    const id = new ObjectId();
    const expected = await seedPoll(id, POLL_CREATED_AT);
    await copyPolls();

    const rows = await getDb()
      .select({ id: pollVotes.id, createdAt: pollVotes.createdAt })
      .from(pollVotes)
      .where(eq(pollVotes.pollId, id.toHexString()))
      .orderBy(pollVotes.createdAt);

    expect(rows).toHaveLength(expected.length);
    // Offsets from the POLL's instant, one millisecond per ordinal — so the
    // sequence is real information and the instants are honestly derived from
    // one that was recorded.
    expect(rows.map((row) => row.createdAt.getTime() - POLL_CREATED_AT.getTime())).toStrictEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });

  it('gives ids that sort lexicographically in ordinal order', async () => {
    const id = new ObjectId();
    await seedPoll(id, POLL_CREATED_AT);
    await copyPolls();

    const rows = await getDb()
      .select({ id: pollVotes.id })
      .from(pollVotes)
      .where(eq(pollVotes.pollId, id.toHexString()))
      .orderBy(pollVotes.createdAt);
    const ids = rows.map((row) => row.id);

    // Zero-padded to a fixed width, or `10` would sort before `9` and scramble
    // exactly what the id exists to preserve.
    expect(ids).toStrictEqual([...ids].sort());
    expect(ids[0]).toBe(`${id.toHexString()}-v000000000`);
  });

  /**
   * The case that makes the zero-padding load-bearing for ORDER rather than for
   * a string format.
   *
   * Below ten votes every ordinal is one digit and lexicographic order agrees
   * with numeric order by accident, so a test at that size cannot tell a padded
   * id from an unpadded one. Twelve votes crosses the boundary where `10` sorts
   * before `9`, and it is asserted through `loadPollRecord` — with no poll
   * timestamp, so the id is the only key carrying the order.
   */
  it('keeps order past the digit boundary, where padding starts to matter', async () => {
    const id = new ObjectId();
    const voters = Array.from({ length: 12 }, (_, index) => `bfp-v${index}`);
    await mongo.collection('polls').insertOne({
      _id: id,
      question: 'bfp wide?',
      createdBy: OWNER,
      endsAt: new Date('2030-01-01T00:00:00.000Z'),
      options: [{ _id: new ObjectId(), text: 'bfp only', votes: voters }],
    });
    await copyPolls();

    const record = await loadPollRecord(getDb(), id.toHexString());
    expect(record?.options[0]?.votes).toStrictEqual(voters);
  });

  it('is idempotent — copying twice leaves one row per vote', async () => {
    const id = new ObjectId();
    const expected = await seedPoll(id, POLL_CREATED_AT);
    await copyPolls();
    await copyPolls();

    const rows = await getDb()
      .select({ id: pollVotes.id })
      .from(pollVotes)
      .where(eq(pollVotes.pollId, id.toHexString()));
    // A non-deterministic id would double every vote here, and the
    // `(option_id, user_id)` unique index would mask most of it by accident.
    expect(rows).toHaveLength(expected.length);
  });
});

describe('the rest of the poll', () => {
  it('preserves option order and the subdocument ids', async () => {
    const id = new ObjectId();
    await seedPoll(id, POLL_CREATED_AT);
    await copyPolls();

    const options = await getDb()
      .select({ position: pollOptions.position, text: pollOptions.text })
      .from(pollOptions)
      .where(eq(pollOptions.pollId, id.toHexString()))
      .orderBy(pollOptions.position);
    expect(options.map((option) => option.text)).toStrictEqual([
      'bfp option one',
      'bfp option two',
    ]);
    expect(options.map((option) => option.position)).toStrictEqual([0, 1]);
  });

  it('copies the poll’s renamed timestamps rather than the migration clock', async () => {
    const id = new ObjectId();
    await seedPoll(id, POLL_CREATED_AT);
    await copyPolls();

    const [row] = await getDb().select().from(polls).where(eq(polls.id, id.toHexString()));
    // `PollSchema` is the one model that renames these to `created_at` /
    // `updated_at`; reading the default names would find nothing and stamp the
    // migration's own clock over every poll's history.
    expect(row?.createdAt).toStrictEqual(POLL_CREATED_AT);
    expect(row?.updatedAt).toStrictEqual(POLL_CREATED_AT);
  });
});
