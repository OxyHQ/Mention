/**
 * The uniqueness report's own truncation — and why it stopped being a truncated
 * VERDICT.
 *
 * `auditUniqueness` describes at most {@link COLLISION_GROUPS_REPORTED} colliding
 * groups per index. That cap used to be a `$limit` INSIDE the aggregation, which
 * made it two things at once: a bound on how much the report says, and a bound on
 * how much the audit LOOKED AT. The second is the dangerous one — production
 * holds 569 colliding `federated_actors_uri_key` groups over 1,156 documents and
 * the audit reported fifty, so 519 groups were never tested for resolution at
 * all. A run could have been certified clean and then hit a `23505` on a group
 * nobody examined, hours in, which is the exact outcome this phase exists to
 * prevent.
 *
 * So the cap now bounds only the report, and two properties are asserted here
 * because they fail in opposite directions:
 *
 *  1. the count is TRUE — "50 of 51", not "50", so a floor cannot read as a fact;
 *  2. the verdict COVERS the unlisted groups — an unresolved collision past the
 *     cap still blocks the copy.
 *
 * Fixtures are `buc-` prefixed and every id is scoped to this file — vitest runs
 * files in parallel against one database.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  auditUniqueness,
  auditWouldBlockCopy,
  COLLISION_GROUPS_REPORTED,
  type AuditFinding,
} from '../../db/backfill/audit';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import {
  createResolutionContext,
  planResolutions,
  ResolutionLog,
  type ResolutionRule,
} from '../../db/backfill/resolutions';
import type { CollectionPlan } from '../../db/backfill/plan';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

/** One more group than the report describes — the smallest fixture that truncates. */
const GROUPS = COLLISION_GROUPS_REPORTED + 1;

/**
 * The `federatedactors` plan with its dedup rule REMOVED.
 *
 * The real plan resolves these collisions, and `planResolutions` now runs that
 * rule's pre-pass for real — so against the live plan every fixture group comes
 * back answered, which is the right behaviour and the wrong instrument for
 * measuring a cap. Stripping `resolvedBy` asks the question this file is about:
 * what does the report say, and what does the verdict cover, when nothing
 * answers the collisions.
 */
const unanswered = (): CollectionPlan => {
  const plan = planFor('federatedactors');
  return {
    ...plan,
    uniquenessAudits: (plan.uniquenessAudits ?? []).map(({ resolvedBy: _ignored, ...rest }) => rest),
  };
};

async function audit(plan: CollectionPlan, actedOn?: ReadonlyMap<string, ReadonlySet<string>>) {
  const plan_ = await planResolutions(source);
  const resolutions = createResolutionContext(
    actedOn === undefined ? plan_ : { actedOn },
    new ResolutionLog()
  );
  return auditUniqueness(source, plan, resolutions);
}

/** The truncation notice, told from a per-group finding by its wording. */
const noticeIn = (findings: readonly AuditFinding[]) =>
  findings.find((finding) => finding.detail.includes('colliding group(s)'));

/**
 * `${GROUPS}` pairs of federated actors, each pair sharing one `uri`.
 *
 * `federatedactors` is the real collection this fired on, so the fixture uses
 * its real plan and its real index rather than a synthetic one — a cap that is
 * only ever exercised against a made-up audit proves nothing about the audit
 * that actually truncated.
 */
async function insertCollidingPairs(count: number): Promise<void> {
  const docs = [];
  for (let index = 0; index < count; index += 1) {
    const uri = `https://buc.example/users/a${index}`;
    for (const side of ['x', 'y']) {
      docs.push({
        _id: new ObjectId(),
        uri,
        acct: `buc-${index}-${side}@buc.example`,
        domain: 'buc.example',
        username: `buc-${index}-${side}`,
        actorType: 'Person',
      });
    }
  }
  await mongo.collection('federatedactors').insertMany(docs);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_uniqueness_cap_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  await mongo.collection('federatedactors').deleteMany({});
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

describe('the report cap', () => {
  it('describes at most the cap, and says how many it did not describe', async () => {
    await insertCollidingPairs(GROUPS);

    const findings = await audit(unanswered());
    const uriFindings = findings.filter((finding) => finding.detail.startsWith('federated_actors_uri_key'));
    const notice = noticeIn(uriFindings);

    // The cap still bounds the report — that part is deliberate.
    expect(uriFindings.length).toBe(COLLISION_GROUPS_REPORTED + 1); // + the notice
    expect(notice).toBeDefined();
    // …and the notice carries the TRUE total, which is the whole point.
    expect(notice?.detail).toContain(`${COLLISION_GROUPS_REPORTED} of ${GROUPS} colliding group(s)`);
    // Documents too: two per pair, so the real extent is visible without
    // multiplying anything out by hand.
    expect(notice?.detail).toContain(`of ${GROUPS * 2} document(s)`);
  });

  it('says nothing at all when every group fits', async () => {
    // A notice on an untruncated report would be noise, and noise is what gets
    // a gate ignored.
    await insertCollidingPairs(2);

    const findings = await audit(unanswered());
    expect(noticeIn(findings)).toBeUndefined();
    expect(findings.filter((f) => f.detail.startsWith('federated_actors_uri_key'))).toHaveLength(2);
  });
});

describe('the VERDICT past the cap', () => {
  it('BLOCKS on an unresolved collision the report never listed', async () => {
    // The bug this replaces: with the cap inside the aggregation, group 51 was
    // never fetched, never tested, and never mentioned — and the copy was
    // certified against fifty of fifty-one.
    await insertCollidingPairs(GROUPS);

    const notice = noticeIn(await audit(unanswered()));

    expect(notice).toBeDefined();
    expect(auditWouldBlockCopy(notice as AuditFinding)).toBe(true);
    expect(notice?.detail).toContain('is NOT answered by any rule');
    // It hands over ids, so the operator can look at a row rather than a number.
    expect(notice?.sampleIds.length).toBeGreaterThan(0);
  });

  it('does NOT block when a rule answers every unlisted group', async () => {
    await insertCollidingPairs(GROUPS);

    // The rule acts on all but one row of every group — the shape
    // `resolvesUniquenessGroup` demands, applied here to the unlisted remainder.
    const rows = await mongo
      .collection('federatedactors')
      .find({}, { projection: { _id: 1, uri: 1 } })
      .toArray();
    const byUri = new Map<string, string[]>();
    for (const row of rows) {
      const list = byUri.get(String(row.uri)) ?? [];
      list.push(String(row._id));
      byUri.set(String(row.uri), list);
    }
    const nonSurvivors = new Set<string>();
    for (const ids of byUri.values()) for (const id of ids.slice(1)) nonSurvivors.add(id);

    const rule: ResolutionRule = {
      id: 'buc-test-rule',
      collection: 'federatedactors',
      finding: 'test',
      decision: 'test',
    };
    const plan: CollectionPlan = {
      ...planFor('federatedactors'),
      uniquenessAudits: [
        { index: 'federated_actors_uri_key', key: [{ path: 'uri', normalize: 'exact' }], resolvedBy: rule },
      ],
    };

    const notice = noticeIn(await audit(plan, new Map([[rule.id, nonSurvivors]])));

    expect(notice).toBeDefined();
    expect(auditWouldBlockCopy(notice as AuditFinding)).toBe(false);
    expect(notice?.detail).toContain('answered by a documented resolution rule');
  });
});
