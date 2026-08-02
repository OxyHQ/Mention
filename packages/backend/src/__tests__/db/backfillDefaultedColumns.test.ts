/**
 * `NOT NULL DEFAULT` columns the transform leaves to the database — the one
 * shape where an audit's silence is not evidence.
 *
 * A `NOT NULL` column with NO default fails loudly when a value is missing:
 * `buildRow` names the table, the column and the document. A `NOT NULL` column
 * WITH a default fails silently — the row inserts, Postgres supplies the value,
 * and a source field that was absent becomes a value nobody chose. Nothing
 * raises, nothing counts it, and after the run there is nothing left to notice.
 *
 * Measured, which is why this audit exists: six posts of 577,526 in production
 * carry no `createdAt`, and `posts.created_at` is exactly this shape. Left alone
 * all six would take `now()` and sit at the top of every chronological feed on
 * day one.
 *
 * The audit reports rather than decides, because both answers are legitimate: a
 * counter with no source field genuinely should default to zero, a creation
 * timestamp should not be invented. What it refuses to allow is the third
 * option, which is not noticing.
 *
 * Fixtures are `bfd-` prefixed. Nothing here writes to Postgres at all — the
 * audit runs transforms and inserts nothing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { auditDefaultedColumns, auditWouldBlockCopy } from '../../db/backfill/audit';
import { runAudits } from '../../db/backfill/runner';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { tableShape } from '../../db/backfill/rowBuilder';
import { pushTokens } from '../../db/schema/discovery';
import type { CollectionPlan } from '../../db/backfill/plan';
import {
  createResolutionContext,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

async function audit(plan: CollectionPlan) {
  return auditDefaultedColumns(
    source,
    plan,
    createResolutionContext(await planResolutions(source), new ResolutionLog())
  );
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_defaulted_test');
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
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('the defaulted-column set', () => {
  it('is derived from the schema, and is disjoint from the required set', () => {
    // The two behave in OPPOSITE ways for the same omission — one raises 23502,
    // the other silently substitutes — so a column in both, or in neither by
    // mistake, would make the audit ask the wrong question of it.
    const shape = tableShape(pushTokens);
    for (const property of shape.defaulted) {
      expect(shape.required.has(property)).toBe(false);
    }
    // `created_at` on this table is `NOT NULL DEFAULT now()`: the exact shape.
    expect(shape.defaulted.has('createdAt')).toBe(true);
    // …and `token` is `NOT NULL` with no default, so it belongs to the other set.
    expect(shape.required.has('token')).toBe(true);
    expect(shape.defaulted.has('token')).toBe(false);
  });
});

describe('auditDefaultedColumns', () => {
  it('COUNTS the documents whose absent field would take the database default', async () => {
    // `pushtokens` declares `{ timestamps: true }`, and `timestamps()` omits the
    // key when the source has none — which is correct, and is exactly the
    // silent substitution this audit exists to surface.
    await mongo.collection('pushtokens').insertMany([
      { _id: new ObjectId(), userId: 'bfd-1', token: 'bfd-token-1', platform: 'ios' },
      { _id: new ObjectId(), userId: 'bfd-2', token: 'bfd-token-2', platform: 'ios' },
      {
        _id: new ObjectId(),
        userId: 'bfd-3',
        token: 'bfd-token-3',
        platform: 'ios',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    ]);

    const findings = await audit(planFor('pushtokens'));
    const created = findings.find((finding) => finding.detail.includes('createdAt'));

    expect(created).toBeDefined();
    // TWO of three — the count is the whole point. A boolean "some document
    // somewhere" would not let an operator tell six rows from six hundred
    // thousand, which is the difference between deriving and shrugging.
    expect(created?.documents).toBe(2);
    expect(created?.sampleIds).toHaveLength(2);
    expect(created?.kind).toBe('defaulted-column');
    // It names the table and column, so it is actionable without opening code.
    expect(created?.detail).toContain('push_tokens.createdAt');
  });

  it('says NOTHING when the transform supplies every defaulted column', async () => {
    await mongo.collection('pushtokens').insertOne({
      _id: new ObjectId(),
      userId: 'bfd-4',
      token: 'bfd-token-4',
      platform: 'ios',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      // `lastSeenAt` is `NOT NULL DEFAULT now()` too, and `optionalDate` omits
      // it when absent — so it has to be supplied here or this control is not
      // controlling for what it claims.
      lastSeenAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    // The negative control. Without it the case above cannot tell an audit that
    // detects omissions from one that reports every defaulted column always.
    expect(await audit(planFor('pushtokens'))).toStrictEqual([]);
  });

  it('BLOCKS the copy, because Postgres would accept the row', async () => {
    await mongo.collection('pushtokens').insertOne({
      _id: new ObjectId(),
      userId: 'bfd-5',
      token: 'bfd-token-5',
      platform: 'ios',
    });

    const findings = await audit(planFor('pushtokens'));
    expect(findings.length).toBeGreaterThan(0);
    // Every other blocking class is something the server REFUSES, so stopping
    // is the cheaper of two failures. This one the server accepts — which is
    // precisely why it has to block: an un-blocked finding is a value nobody
    // chose landing in production with nothing left to notice it afterwards.
    expect(findings.every(auditWouldBlockCopy)).toBe(true);
  });

  it('is cleared by an acknowledgement, and the acknowledgement carries a reason', async () => {
    await mongo.collection('pushtokens').insertOne({
      _id: new ObjectId(),
      userId: 'bfd-6',
      token: 'bfd-token-6',
      platform: 'ios',
    });

    const base = planFor('pushtokens');
    const acknowledged: CollectionPlan = {
      ...base,
      defaultedColumns: [
        {
          column: pushTokens.createdAt,
          reason:
            'A push token registered before the model declared timestamps has no ' +
            'creation time anywhere, and the token itself is what matters.',
        },
        {
          column: pushTokens.updatedAt,
          reason: 'Same shape as createdAt on this collection.',
        },
        {
          column: pushTokens.lastSeenAt,
          reason:
            'A token never seen since the field was added has no last-seen time, ' +
            'and now() is the honest floor for one that is registering right now.',
        },
      ],
    };

    expect(await audit(acknowledged)).toStrictEqual([]);
  });

  it('REPORTS an acknowledgement for a column the transform always supplies', async () => {
    await mongo.collection('pushtokens').insertOne({
      _id: new ObjectId(),
      userId: 'bfd-7',
      token: 'bfd-token-7',
      platform: 'ios',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    const base = planFor('pushtokens');
    const stale: CollectionPlan = {
      ...base,
      defaultedColumns: [
        {
          column: pushTokens.createdAt,
          reason: 'Describes behaviour that no longer happens.',
        },
      ],
    };

    const findings = await audit(stale);
    // An exemption list nobody re-measures is how a gate decays into a
    // formality — so the list is checked against the behaviour it claims to
    // describe, in the same way the referential audit reconciles its derived
    // relations against `pg_constraint` rather than trusting the derivation.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('stale-acknowledgement');
    expect(findings[0]?.detail).toContain('createdAt');
    expect(findings.every(auditWouldBlockCopy)).toBe(true);
  });

  it('covers the PRIMARY KEY, which is the column that must never be defaulted', async () => {
    // `generatedId()` is `text().primaryKey().$defaultFn(uuidv7)`, so `id` is
    // NOT NULL with a default and lands in the audited set. That is not an
    // accident worth filtering out — it is the single most valuable member.
    //
    // The whole migration rests on ids being preserved VERBATIM: a 24-char
    // ObjectId hex goes into the text column unchanged, and every foreign key,
    // every published ActivityPub URI and every client-held id depends on it. A
    // transform that omitted `id` would mint a fresh uuid v7 instead — silently,
    // because the row inserts perfectly well — and every relation to it would
    // point at a row that no longer answers to that name. This audit is the only
    // check in the suite that would see it.
    expect(tableShape(pushTokens).defaulted.has('id')).toBe(true);

    const omitsTheId: CollectionPlan = {
      ...planFor('pushtokens'),
      transform: (doc, emit) => {
        void doc;
        // Everything a `push_tokens` row needs EXCEPT the id.
        emit(pushTokens, {
          userId: 'bfd-8',
          token: 'bfd-token-8',
          type: 'unknown',
          platform: 'ios',
          enabled: true,
          lastSeenAt: new Date('2024-01-01T00:00:00.000Z'),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        });
      },
    };
    await mongo.collection('pushtokens').insertOne({
      _id: new ObjectId(),
      userId: 'bfd-8',
      token: 'bfd-token-8',
      platform: 'ios',
    });

    const findings = await audit(omitsTheId);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain('push_tokens.id');
    expect(findings[0]?.kind).toBe('defaulted-column');
  });

  it('surfaces through runAudits, not only through the function itself', async () => {
    // Without this, every case above would still pass with the call deleted
    // from `runAudits` — the audit correct, tested, and never invoked. That is
    // the same shape as the referential-coverage bug: a gate nothing calls.
    await mongo.collection('pushtokens').insertOne({
      _id: new ObjectId(),
      userId: 'bfd-9',
      token: 'bfd-token-9',
      platform: 'ios',
    });

    const report = await runAudits(
      await connectPostgres(),
      source,
      {
        migrated: [{ plan: planFor('pushtokens'), documents: 1 }],
        excluded: [],
        unknown: [],
        absent: [],
      },
      createResolutionContext(await planResolutions(source), new ResolutionLog())
    );

    expect(report.findings.some((finding) => finding.kind === 'defaulted-column')).toBe(true);
    // …and because it blocks, the referential pass is deliberately NOT run: a
    // clean referential verdict over data an earlier audit already refused
    // would be a claim nobody may rely on.
    expect(report.referentialIntegrity.notRunReason).toBeDefined();
  });

  it('finds nothing across every plan when the source is empty', async () => {
    // A vacuity floor of a different kind: it proves the traversal reaches all
    // 45 plans without throwing on any of them, which a per-collection case
    // cannot. An empty collection emits no rows, so a clean answer here is the
    // right one — and a transform that threw on the empty case would surface.
    for (const plan of COLLECTION_PLANS) {
      expect(await audit(plan)).toStrictEqual([]);
    }
    expect(COLLECTION_PLANS.length).toBeGreaterThan(40);
  });
});
