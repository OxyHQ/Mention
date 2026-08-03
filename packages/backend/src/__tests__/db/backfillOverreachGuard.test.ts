/**
 * The overreach guard, and the display cap that made it lie.
 *
 * `resolution-overreach` is the last thing standing between a resolution rule
 * and live production data: it asks, independently of what the rule reports,
 * whether the rule acted on a row whose parent EXISTS. No rule may answer it.
 *
 * It was asking that question of the wrong set. `OrphanAccumulator` held ONE
 * map, `documentsByValue`, serving two readers at once — a human-facing sample
 * capped at `MAX_REPORTED_ORPHAN_VALUES` so a bad join cannot flood the report,
 * and the machine-facing reference set this guard filters against. Capping it
 * for the first reader silently narrowed the second, so every distinct value
 * past the 50th came back as "the migration DOES produce this row".
 *
 * Run 10 (2026-08-03) therefore accused all four orphan rules of deleting live
 * production data, with specific ids attached. The fingerprint was arithmetic:
 * 208, 399, 118 and 399 "unexplained" values, each exactly the relation's
 * distinct-value count minus 50 — `thread_id` matching to the unit at 168 − 50.
 * Every finding also read "acted on N row(s) … found only N row(s)", the SAME
 * N, which is what a correct rule under a broken check looks like.
 *
 * THE FIXTURE MUST CARRY MORE THAN 50 DISTINCT MISSING PARENTS. At 50 or fewer
 * the capped and uncapped implementations are identical and this file passes
 * against the bug — vacuous by construction. The count is asserted explicitly
 * below so that shrinking it turns the test red rather than disarming it.
 *
 * Fixtures are `bog-` prefixed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq } from 'drizzle-orm';
import { auditReferentialIntegrity } from '../../db/backfill/referentialIntegrity';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import {
  createResolutionContext,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

const OWNER = 'bog-owner-1';

/**
 * More than 50, and deliberately not a round number.
 *
 * 50 is the cap; a fixture AT the cap proves nothing, so this has to exceed it
 * by enough that the "unexplained" count under the bug (`DISTINCT - 50`) is
 * unmistakably non-zero rather than one or two values that could be noise.
 */
const DISTINCT_MISSING_PARENTS = 64;

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

const basePost = (id: ObjectId, extra: Record<string, unknown> = {}) => ({
  _id: id,
  oxyUserId: OWNER,
  visibility: 'private',
  content: {},
  createdAt: new Date('2024-02-03T04:05:06.007Z'),
  updatedAt: new Date('2024-02-03T04:05:06.007Z'),
  ...extra,
});

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_overreach_guard_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  await getDb().delete(posts).where(eq(posts.oxyUserId, OWNER));
  await mongo.collection('posts').deleteMany({});
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('a rule acting on more distinct values than the report will print', () => {
  it('is NOT accused of overreach', async () => {
    // One post that exists, so the emitted key set is non-empty, plus N replies
    // each naming a DIFFERENT parent that does not.
    const real = new ObjectId();
    const missing = Array.from({ length: DISTINCT_MISSING_PARENTS }, () => new ObjectId());
    await mongo.collection('posts').insertMany([
      basePost(real),
      ...missing.map((parent) =>
        basePost(new ObjectId(), { parentPostId: parent.toHexString() })
      ),
      // Replies whose parent DOES exist. Without these the fixture cannot see a
      // real overreach at all: widening the rule to fire regardless of the
      // parent changes nothing when every row in the fixture is already an
      // orphan, and the mutation that proves this guard still works survived
      // for exactly that reason the first time it was run.
      ...Array.from({ length: 3 }, () =>
        basePost(new ObjectId(), { parentPostId: real.toHexString() })
      ),
    ]);

    // The fixture's whole load-bearing property, asserted rather than assumed:
    // at or below the cap this test cannot distinguish the fix from the bug.
    const distinct = new Set(missing.map((id) => id.toHexString()));
    expect(distinct.size).toBe(DISTINCT_MISSING_PARENTS);
    expect(distinct.size).toBeGreaterThan(50);

    const report = await auditReferentialIntegrity(
      getDb(),
      source,
      [{ plan: planFor('posts'), documents: DISTINCT_MISSING_PARENTS + 4 }],
      createResolutionContext(await planResolutions(source), new ResolutionLog())
    );

    const overreach = report.findings.filter((finding) => finding.kind === 'resolution-overreach');
    expect(overreach.map((finding) => finding.detail)).toStrictEqual([]);

    // The rows whose parent EXISTS are untouched — the property the guard is
    // there to police, asserted directly rather than only through the guard's
    // silence.
    const kept = report.findings.filter((finding) => finding.kind === 'referential-integrity');
    expect(kept.every((finding) => finding.documents === DISTINCT_MISSING_PARENTS)).toBe(true);

    // And the rule DID act on all of them — otherwise the absence of an
    // overreach finding would be the absence of any activity at all.
    const resolved = report.findings.filter(
      (finding) => finding.kind === 'referential-integrity' && finding.resolvedBy !== undefined
    );
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.some((finding) => finding.documents === DISTINCT_MISSING_PARENTS)).toBe(true);
  });
});
