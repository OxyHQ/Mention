/**
 * The streaming half of the coverage check — the part that produces the two
 * counts the pure function compares.
 *
 * Three properties, and each is a way the pass could be wrong while looking
 * right:
 *
 *  - the SOURCE count and the POPULATED count come from one stream, so a
 *    document the transform refused cannot land on one side and not the other;
 *  - a dotted path descends into ARRAYS, because a child table is filled from a
 *    subdocument array and a reader that stopped at one would report every
 *    array-backed declaration as a typo;
 *  - demonstrated loss BLOCKS the copy, and an admission that the check cannot
 *    tell does not.
 *
 * Nothing here writes to Postgres. The pass runs transforms and inserts nothing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Db } from 'mongodb';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { auditColumnCoverageForPlan, auditWouldBlockCopy } from '../../db/backfill/audit';
import { holdsValueAt } from '../../db/backfill/columnCoverage';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { buildRow } from '../../db/backfill/rowBuilder';
import { closePostgres } from '../../db/postgres';
import type { CollectionPlan } from '../../db/backfill/plan';
import {
  createResolutionContext,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';
import { reqStr, str } from '../../db/backfill/values';

const gadgets = pgTable('bccp_gadgets', {
  id: text().primaryKey(),
  title: text().notNull(),
  nickname: text(),
  /** NOT NULL with a default — the shape a `?? 0` fallback lands in. */
  weight: integer().notNull().default(0),
});

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

const COLLECTION = 'bccpgadgets';

/** A plan mapping `nickname`, so the declaration below has something to measure. */
const mappedPlan: CollectionPlan = {
  collection: COLLECTION,
  table: gadgets,
  columnCoverage: [{ table: gadgets, column: gadgets.nickname, sourcePath: 'nickname' }],
  transform: (doc, emit) => {
    const id = String(doc._id);
    emit(gadgets, buildRow(gadgets, {
      id,
      // `reqStr` THROWS when the field is absent, which is how a document gets
      // refused — the case the atomicity property is about.
      title: reqStr(doc, 'title'),
      nickname: str(doc, 'nickname'),
    }, id));
  },
};

/** The same collection with the mapping REMOVED — the eleven columns' shape. */
const unmappedPlan: CollectionPlan = {
  ...mappedPlan,
  transform: (doc, emit) => {
    const id = String(doc._id);
    emit(gadgets, buildRow(gadgets, { id, title: reqStr(doc, 'title') }, id));
  },
};

async function run(plan: CollectionPlan) {
  return auditColumnCoverageForPlan(
    source,
    plan,
    createResolutionContext(await planResolutions(source), new ResolutionLog())
  );
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_coverage_pass_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  await mongo.collection(COLLECTION).deleteMany({});
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('holdsValueAt', () => {
  it('descends into arrays, which `values.at` deliberately does not', () => {
    // `content.media.url` is the real shape: a child table filled from a
    // subdocument array. A reader that stopped at the array would answer
    // "absent" for every document and turn every child-table declaration into
    // the typo case.
    const doc = { content: { media: [{ type: 'image' }, { url: 'https://x/y.png' }] } };
    expect(holdsValueAt(doc, 'content.media.url')).toBe(true);
    expect(holdsValueAt(doc, 'content.media.mimeType')).toBe(false);
    expect(holdsValueAt(doc, 'content.media')).toBe(true);
  });

  it('treats null and undefined as absent, and a falsy value as present', () => {
    // `false` and `0` are values. Counting them as absent would under-report the
    // source and turn a correctly mapped boolean into over-population.
    expect(holdsValueAt({ a: { b: false } }, 'a.b')).toBe(true);
    expect(holdsValueAt({ a: { b: 0 } }, 'a.b')).toBe(true);
    expect(holdsValueAt({ a: { b: null } }, 'a.b')).toBe(false);
    expect(holdsValueAt({ a: {} }, 'a.b')).toBe(false);
    expect(holdsValueAt({ a: 'scalar' }, 'a.b')).toBe(false);
  });
});

describe('auditColumnCoverageForPlan', () => {
  it('stays silent when every source value reaches the column', async () => {
    // The healthy case first: without it, a pass that reported on everything
    // would satisfy each of the cases below.
    await mongo.collection(COLLECTION).insertMany([
      { title: 'a', nickname: 'one' },
      { title: 'b', nickname: 'two' },
      { title: 'c' },
    ]);
    expect(await run(mappedPlan)).toStrictEqual([]);
  });

  it('reports the values a dropped mapping loses, and BLOCKS the copy', async () => {
    // The eleven, reproduced: the column is declared, the source holds values,
    // and nothing writes it. Postgres accepts every row, which is exactly why
    // this has to stop the run rather than appear in a report nobody reads.
    await mongo.collection(COLLECTION).insertMany([
      { title: 'a', nickname: 'one' },
      { title: 'b', nickname: 'two' },
      { title: 'c' },
    ]);
    const findings = await run(unmappedPlan);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('column-coverage');
    expect(findings[0]?.documents).toBe(2);
    expect(findings[0]?.detail).toMatch(/2 source document\(s\) hold a value/);
    expect(auditWouldBlockCopy(findings[0]!)).toBe(true);
  });

  it('counts a REFUSED document on neither side', async () => {
    // The atomicity property. `refused` carries a nickname the transform never
    // gets to read, because `reqStr(doc, 'title')` throws first. If the source
    // count took it and the row count did not, the pass would invent a
    // one-value shortfall on a column that is mapped perfectly — a finding
    // manufactured by a refusal somewhere else in the same document.
    await mongo.collection(COLLECTION).insertMany([
      { title: 'a', nickname: 'one' },
      { nickname: 'refused, and its nickname must not be counted' },
    ]);
    expect(await run(mappedPlan)).toStrictEqual([]);
  });

  it('says it cannot tell about an undeclared empty column, and does NOT block', async () => {
    // The admission. `nickname` receives nothing and no path is declared, so the
    // honest answer is "no idea" — and gating the cutover on that would make the
    // gate about paperwork rather than evidence.
    await mongo.collection(COLLECTION).insertMany([{ title: 'a' }, { title: 'b' }]);
    const findings = await run({ ...unmappedPlan, columnCoverage: undefined });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('undeclared-column');
    expect(findings[0]?.detail).toMatch(/No `sourcePath` is declared/);
    expect(auditWouldBlockCopy(findings[0]!)).toBe(false);
  });

  it('reaches a NOT NULL column filled with a fabricated constant', async () => {
    // The disguise `auditDefaultedColumns` cannot see: the transform SUPPLIES
    // `weight`, so nothing is omitted and no defaulted-column finding is raised,
    // while two of the three rows carry a zero the source never held.
    await mongo.collection(COLLECTION).insertMany([
      { title: 'a', weight: 7 },
      { title: 'b' },
      { title: 'c' },
    ]);
    const findings = await run({
      collection: COLLECTION,
      table: gadgets,
      columnCoverage: [{ table: gadgets, column: gadgets.weight, sourcePath: 'weight' }],
      unmappedColumns: [
        { table: gadgets, column: gadgets.nickname, reason: 'the source has no such field' },
      ],
      transform: (doc, emit) => {
        const id = String(doc._id);
        emit(gadgets, buildRow(gadgets, {
          id,
          title: reqStr(doc, 'title'),
          weight: typeof doc.weight === 'number' ? doc.weight : 0,
        }, id));
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('column-coverage');
    expect(findings[0]?.detail).toMatch(/3 row\(s\) but only 1 source document\(s\)/);
    expect(findings[0]?.detail).toMatch(/2 row\(s\) carry a value the source did not supply/);
    expect(auditWouldBlockCopy(findings[0]!)).toBe(true);
  });
});
