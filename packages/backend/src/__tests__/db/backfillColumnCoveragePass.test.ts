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
  type ResolutionRule,
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

/** A rule that removes a document WHOLE — the shape `plans/federation.ts` uses. */
const DROP_SUPERSEDED: ResolutionRule = {
  id: 'bccp-drop-superseded',
  collection: COLLECTION,
  finding: 'two rows describe the same gadget',
  decision: 'copy the maintained row; drop the superseded one whole',
};

/** The mapped plan, except a rule drops any document marked `superseded`. */
const droppingPlan: CollectionPlan = {
  ...mappedPlan,
  transform: (doc, emit, resolutions) => {
    const id = String(doc._id);
    if (doc.superseded === true) {
      resolutions.dropDocument(DROP_SUPERSEDED, COLLECTION, id, 'superseded by the maintained row');
      return;
    }
    emit(gadgets, buildRow(gadgets, {
      id,
      title: reqStr(doc, 'title'),
      nickname: str(doc, 'nickname'),
    }, id));
  },
};

/**
 * Emits nothing and decides nothing — the UNDECIDED drop.
 *
 * Deliberately NOT a variant of `droppingPlan`: it is the case the guard below
 * must keep blocking, and the only difference between them is whether a rule
 * recorded the removal.
 */
const silentlySkippingPlan: CollectionPlan = {
  ...mappedPlan,
  transform: (doc, emit) => {
    const id = String(doc._id);
    if (doc.superseded === true) return;
    emit(gadgets, buildRow(gadgets, {
      id,
      title: reqStr(doc, 'title'),
      nickname: str(doc, 'nickname'),
    }, id));
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

  it('does not count a value a RULE removed as a value the copy lost', async () => {
    // The gap that refused a whole re-rehearsal on five findings nothing had
    // lost. A rule drops the document; the SOURCE side counted it anyway,
    // because it walks the collection rather than the emitted rows. So the one
    // document holding `nickname: 'two'` reads as a value the copy dropped —
    // and a coverage finding blocks the run over data somebody decided, in
    // writing, not to carry.
    await mongo.collection(COLLECTION).insertMany([
      { title: 'a', nickname: 'one' },
      { title: 'b', nickname: 'two', superseded: true },
    ]);
    expect(await run(droppingPlan)).toStrictEqual([]);
  });

  it('still reports a document that vanished with NO rule behind it', async () => {
    // The other half, and the reason the exclusion is keyed on a recorded drop
    // rather than on "emitted no rows": that wider predicate would swallow this
    // case too. Same two documents, same missing row, no decision anywhere —
    // an undecided drop is exactly what the pass exists to catch, so it must
    // still block.
    await mongo.collection(COLLECTION).insertMany([
      { title: 'a', nickname: 'one' },
      { title: 'b', nickname: 'two', superseded: true },
    ]);
    const findings = await run(silentlySkippingPlan);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some(auditWouldBlockCopy)).toBe(true);
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
    expect(findings[0]?.kind).toBe('unverified-column');
    expect(findings[0]?.detail).toMatch(/No `sourcePath` is declared/);
    expect(auditWouldBlockCopy(findings[0]!)).toBe(false);
  });

  it('does NOT block on a declared path no document holds', async () => {
    // The other admission, and the one that would have been costly to get
    // wrong: a path matching nothing is a typo OR a field that is genuinely
    // empty today, and the two are indistinguishable from here. Blocking would
    // refuse the copy permanently for every correctly mapped column whose
    // source field simply holds nothing yet — `trending.status`, `label_version`
    // and `topic_id` are all in exactly that state. There is no data to lose
    // either way, so it is reported loudly and the copy proceeds.
    await mongo.collection(COLLECTION).insertMany([{ title: 'a' }, { title: 'b' }]);
    const findings = await run({
      ...unmappedPlan,
      columnCoverage: [{ table: gadgets, column: gadgets.nickname, sourcePath: 'nikcname' }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('unverified-column');
    expect(findings[0]?.detail).toMatch(/mistyped or renamed/);
    expect(auditWouldBlockCopy(findings[0]!)).toBe(false);
  });

  it('accepts an uncarried field whose count has not grown', async () => {
    // The healthy half. A field deleted from a Mongoose schema keeps its stored
    // key — MongoDB does not `$unset` on a schema change — so the data outlives
    // the code and the target has no column to notice missing. Declaring it is
    // the only way anything can look at it, and a frozen count is what "nothing
    // writes this any more" looks like when it is still true.
    await mongo.collection(COLLECTION).insertMany([
      { title: 'a', legacy: 'residue' },
      { title: 'b', legacy: 'residue' },
      { title: 'c' },
    ]);
    const findings = await run({
      ...mappedPlan,
      columnCoverage: undefined,
      unmappedColumns: [
        { table: gadgets, column: gadgets.nickname, reason: 'the source has no such field' },
      ],
      uncarriedFields: [{ sourcePath: 'legacy', observed: 2, reason: 'superseded by `title`' }],
    });
    expect(findings).toStrictEqual([]);
  });

  it('reports an uncarried field that has STARTED being written again', async () => {
    // The tripwire, and the whole reason the declaration records a NUMBER
    // rather than reading "nothing writes this". A prose note is true when
    // written and silent forever after; the count makes the claim checkable,
    // and growth is the one observation that falsifies it.
    await mongo.collection(COLLECTION).insertMany([
      { title: 'a', legacy: 'residue' },
      { title: 'b', legacy: 'residue' },
      { title: 'c', legacy: 'WRITTEN AFTER THE REASON WAS RECORDED' },
    ]);
    const findings = await run({
      ...mappedPlan,
      columnCoverage: undefined,
      unmappedColumns: [
        { table: gadgets, column: gadgets.nickname, reason: 'the source has no such field' },
      ],
      uncarriedFields: [{ sourcePath: 'legacy', observed: 2, reason: 'superseded by `title`' }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('stale-acknowledgement');
    expect(findings[0]?.documents).toBe(3);
    expect(findings[0]?.detail).toMatch(/3 hold it now/);
    expect(findings[0]?.detail).toMatch(/dropping live data/);
    expect(auditWouldBlockCopy(findings[0]!)).toBe(true);
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
