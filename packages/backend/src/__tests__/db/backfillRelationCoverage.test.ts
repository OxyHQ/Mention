/**
 * Does the referential audit actually derive the foreign keys it claims to?
 *
 * The audit reads relations out of the drizzle metadata and then reports "N
 * relations inspected, 0 orphans". That sentence is indistinguishable between a
 * derivation that found every constraint and one that found a fifth of them —
 * and the second reads as a clean bill of health for a graph nobody checked.
 * Measured at the time this was written: the schema declared 42 foreign keys and
 * the audit derived 8, with nothing anywhere saying so.
 *
 * `pg_constraint` is the authority, for the same reason `listCollections()` is
 * the authority on the Mongo side: the CODE is the thing that might be wrong, so
 * it cannot also be the thing that grades itself.
 *
 * These cases run against the REAL migrated throwaway database the vitest
 * harness builds from `drizzle/`, so "deployed" means what the migrations
 * actually created, not what the schema module says they should have.
 *
 * Every fixture id here is prefixed `bfc-` and nothing in this file writes a row.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { sql } from 'drizzle-orm';
import { getTableConfig, pgTable, text } from 'drizzle-orm/pg-core';
import { connectPostgres, closePostgres, type Database } from '../../db/postgres';
import {
  assertNotVacuous,
  auditReferentialIntegrity,
  deployedForeignKeys,
  reconcileRelations,
  referentialRelations,
  VacuousReferentialIntegrityError,
  type DeployedRelation,
  type ReferentialIntegrityReport,
} from '../../db/backfill/referentialIntegrity';
import {
  COLLECTION_PLANS,
  TABLES_WITH_NO_MONGO_SOURCE,
  allSchemaTables,
  tablesWithoutAPlan,
} from '../../db/backfill/collectionMap';
import { planTables, tableName, type CollectionPlan } from '../../db/backfill/plan';
import { buildRow } from '../../db/backfill/rowBuilder';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import {
  createResolutionContext,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';

/** The tables the CURRENT plan set writes — the audit's claimed scope. */
function plannedTables(): Set<string> {
  const names = new Set<string>();
  for (const plan of COLLECTION_PLANS) {
    for (const table of planTables(plan)) names.add(tableName(table));
  }
  return names;
}

/** A report shell carrying only what the vacuity floor reads. */
function reportWith(coverage: ReferentialIntegrityReport['coverage']): ReferentialIntegrityReport {
  return {
    coverage,
    relationsInspected: 1,
    relationsExercised: 1,
    collectionsInspected: 1,
    documentsInspected: 1,
    referencesChecked: 1,
    orphans: [],
    emissions: [],
    findings: [],
  };
}

const deployedFixture = (
  constraint: string,
  tableName: string,
  targetTableName = 'bfc-target'
): DeployedRelation => ({ constraint, tableName, targetTableName });

/**
 * Two throwaway child tables of `posts`, and the difference between them is the
 * whole point of the end-to-end section below.
 *
 * `bfw_blind` is created in Postgres WITH a foreign key that its drizzle
 * declaration does NOT carry — which is exactly the real-world defect this
 * audit exists to notice: a constraint a migration added by hand, or one the
 * drizzle metadata lost. Its shortfall therefore comes from the DERIVATION
 * PATH, not from handing `reconcileRelations` a short list, so the case drives
 * the real composition rather than re-testing the unit.
 *
 * `bfw_seen` declares the same relation on both sides and is the control: the
 * audit must NOT refuse it, or the gate fires on a healthy schema.
 */
const bfwParent = pgTable('bfw_parent', { id: text().primaryKey() });

const bfwBlind = pgTable('bfw_blind', {
  id: text().primaryKey(),
  // NO `.references()` — the drizzle metadata is deliberately blind to the
  // constraint the DDL below creates.
  parentId: text(),
});

const bfwSeen = pgTable('bfw_seen', {
  id: text().primaryKey(),
  parentId: text().references(() => bfwParent.id, { onDelete: 'cascade' }),
});

/**
 * The parent is a THROWAWAY table too, not `posts`, and that is not cosmetic.
 *
 * `create table … references posts(id)` takes a SHARE ROW EXCLUSIVE lock on
 * `posts`, and so does the matching `drop table`. Every other file that writes a
 * post then blocks behind this file's DDL — measured: pointing these at `posts`
 * turned four cases across three files red with second-long waits, in files that
 * had not changed. Referencing a table only this file knows about touches no
 * shared object at all.
 */
const SEEN_CONSTRAINT = 'bfw_seen_parent_id_bfw_parent_id_fk';
/** The same shape, on the table drizzle cannot see. */
const BLIND_CONSTRAINT = 'bfw_blind_parent_id_bfw_parent_id_fk';

function planFor(table: typeof bfwBlind | typeof bfwSeen, collection: string): CollectionPlan {
  return {
    collection,
    table,
    transform: (doc, emit) => {
      emit(
        table,
        buildRow(table, { id: String(doc._id), parentId: null }, String(doc._id))
      );
    },
  };
}

let mongod: MongoMemoryServer;
let mongoClient: MongoClient;
let mongo: Db;
let source: MongoSource;

async function resolutions() {
  return createResolutionContext(await planResolutions(source), new ResolutionLog());
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  mongoClient = await MongoClient.connect(mongod.getUri());
  mongo = mongoClient.db('backfill_coverage_test');
  source = mongoSourceFromDb(mongo, async () => {
    await mongoClient.close();
  });
}, 120_000);

afterAll(async () => {
  await mongoClient.close();
  await mongod.stop();
});

/**
 * Create the two throwaway tables, run `body`, and drop them again.
 *
 * They are created INSIDE each case rather than in `beforeAll` on purpose: the
 * `deployed.length === declared` assertion in this same file counts every
 * foreign key in the database, and a table that outlived its case would break
 * it. Cases within one file run serially, so create-and-drop keeps them
 * invisible to every other assertion here — and this file is the only one that
 * creates a table, so no other file can see them either.
 */
async function withThrowawayTables(db: Database, body: () => Promise<void>): Promise<void> {
  await db.execute(sql`create table if not exists bfw_parent (id text primary key)`);
  await db.execute(sql`
    create table if not exists bfw_blind (
      id text primary key,
      parent_id text,
      constraint ${sql.identifier(BLIND_CONSTRAINT)}
        foreign key (parent_id) references bfw_parent(id) on delete cascade
    )
  `);
  await db.execute(sql`
    create table if not exists bfw_seen (
      id text primary key,
      parent_id text,
      constraint ${sql.identifier(SEEN_CONSTRAINT)}
        foreign key (parent_id) references bfw_parent(id) on delete cascade
    )
  `);
  try {
    await body();
  } finally {
    await db.execute(sql`drop table if exists bfw_blind`);
    await db.execute(sql`drop table if exists bfw_seen`);
    await db.execute(sql`drop table if exists bfw_parent`);
    for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
      await mongo.collection(name.name).deleteMany({});
    }
  }
}

/**
 * `auditReferentialIntegrity`, driven end to end against a real database.
 *
 * The section that closes the hole every case above leaves open. Those exercise
 * `deployedForeignKeys` and `reconcileRelations` directly, and `assertNotVacuous`
 * on hand-built reports — so the LOGIC is verified, but nothing asserted that
 * the audit PERFORMS the composition. Replacing its internal
 * `await deployedForeignKeys(db)` with the derived set — literally making the
 * checker grade itself, the exact defect this whole file exists to prevent —
 * left all ten of them passing.
 *
 * That matters more here than anywhere else in the backfill, because this
 * check's entire job is to be the one thing that survives the code being wrong.
 * If the call can be deleted silently, it is decoration on the axis it was built
 * for.
 */
describe('auditReferentialIntegrity, end to end', () => {
  /**
   * The plan set carries BOTH tables, and that is load-bearing rather than
   * incidental.
   *
   * A blind-only plan set derives ZERO relations, so `relationsInspected === 0`
   * fires first and the coverage check is never reached — the case would pass
   * on the wrong error, which is exactly what the first draft did until the
   * message assertion below caught it. Pairing the blind table with a table the
   * derivation CAN see puts `relationsInspected` at 1 and leaves the coverage
   * check as the only thing that can refuse the run.
   */
  async function seedBoth(): Promise<void> {
    await mongo.collection('bfwblind').insertOne({ _id: new ObjectId() });
    await mongo.collection('bfwseen').insertOne({ _id: new ObjectId() });
  }

  const blindAndSeen = () => [
    { plan: planFor(bfwSeen, 'bfwseen'), documents: 1 },
    { plan: planFor(bfwBlind, 'bfwblind'), documents: 1 },
  ];

  it('REFUSES a run whose derivation is blind to a constraint Postgres has', async () => {
    const db: Database = await connectPostgres();
    await withThrowawayTables(db, async () => {
      await seedBoth();

      // The shortfall is real and comes from the derivation: `bfw_blind` IS in
      // the plan set (so the constraint is in scope), Postgres HAS the foreign
      // key, and `getTableConfig(bfwBlind).foreignKeys` is empty.
      await expect(
        auditReferentialIntegrity(db, source, blindAndSeen(), await resolutions())
      ).rejects.toThrow(VacuousReferentialIntegrityError);
    });
  });

  it('names the constraint it could not derive, and refuses for THAT reason', async () => {
    const db: Database = await connectPostgres();
    await withThrowawayTables(db, async () => {
      await seedBoth();

      let thrown: unknown;
      try {
        await auditReferentialIntegrity(db, source, blindAndSeen(), await resolutions());
      } catch (error) {
        thrown = error;
      }
      const message = (thrown as Error | undefined)?.message ?? '';
      expect(message).toContain(BLIND_CONSTRAINT);
      // And NOT one of the earlier floors — a refusal is only evidence for this
      // check if it is this check that refused.
      expect(message).not.toContain('no foreign key was derived at all');
      expect(message).toContain('1 of 2');
    });
  });

  it('does NOT refuse when the derivation and the database agree', async () => {
    const db: Database = await connectPostgres();
    await withThrowawayTables(db, async () => {
      await mongo.collection('bfwseen').insertOne({ _id: new ObjectId() });

      const report = await auditReferentialIntegrity(
        db,
        source,
        [{ plan: planFor(bfwSeen, 'bfwseen'), documents: 1 }],
        await resolutions()
      );

      // The control. A gate that fired here would fire on every healthy schema.
      expect(report.coverage?.missing).toEqual([]);
      expect(report.coverage?.deployedInScope).toBe(1);
      expect(report.coverage?.derived).toBe(1);
      expect(report.findings.filter((f) => f.kind === 'undetected-relation')).toEqual([]);
    });
  });

  /**
   * The three ORIGINAL vacuity checks were unwired in exactly the same way —
   * asserted only on hand-built reports, with nothing driving the audit. Two of
   * them are reachable and are driven here.
   *
   * `collectionsInspected === 0` is NOT separately reachable and is left
   * unwired deliberately rather than faked: it requires an empty `planned`,
   * which makes `relationsInspected` zero first, so the earlier check always
   * fires. Saying so is better than a case that appears to cover it.
   */
  it('refuses a run that derived no foreign key at all', async () => {
    const db: Database = await connectPostgres();
    await expect(
      auditReferentialIntegrity(db, source, [], await resolutions())
    ).rejects.toThrow(/no foreign key was derived at all/);
  });

  it('refuses a run that read no document', async () => {
    const db: Database = await connectPostgres();
    await withThrowawayTables(db, async () => {
      // A plan with a real relation, over an EMPTY collection: relations and
      // collections are both non-zero, so this reaches the third check rather
      // than the first.
      await expect(
        auditReferentialIntegrity(
          db,
          source,
          [{ plan: planFor(bfwSeen, 'bfwseen'), documents: 0 }],
          await resolutions()
        )
      ).rejects.toThrow(/no document was read/);
    });
  });
});

describe('the deployed foreign-key set', () => {
  it('reads every foreign key the migrations created', async () => {
    const db: Database = await connectPostgres();
    try {
      const deployed = await deployedForeignKeys(db);

      // A vacuity floor on the AUTHORITY itself. If this query returned nothing
      // — wrong `contype`, wrong namespace, a typo in a join — every coverage
      // check below would pass over an empty set and report perfect coverage of
      // nothing, which is the exact failure mode this whole file exists to
      // close.
      expect(deployed.length).toBeGreaterThan(20);

      // And it should match what the schema module declares, because the
      // migrations are generated from it. A mismatch here is a migration that
      // was never applied, or DDL somebody wrote by hand.
      let declared = 0;
      for (const table of allSchemaTables()) declared += getTableConfig(table).foreignKeys.length;
      expect(deployed.length).toBe(declared);
    } finally {
      await closePostgres();
    }
  });
});

describe('coverage of the current plan set', () => {
  /**
   * THE case. The audit derives relations from the plans; this asserts that set
   * accounts for every deployed constraint on a table those plans write.
   *
   * It also catches a NAMING defect and not merely a missing relation:
   * `describeRelation` reconstructs the constraint name from the SQL column
   * names plus Postgres's truncation, and the comparison is by name. If it
   * computed a name Postgres does not have, the audit has been reporting a
   * constraint that does not exist — and the `23503` an operator eventually
   * sees would not match the report.
   */
  it('derives every deployed foreign key on a table the plans write', async () => {
    const db: Database = await connectPostgres();
    try {
      const coverage = reconcileRelations(
        referentialRelations(COLLECTION_PLANS),
        await deployedForeignKeys(db),
        plannedTables()
      );

      expect(
        coverage.missing.map((relation) => `${relation.constraint} (${relation.tableName})`)
      ).toEqual([]);
      expect(coverage.derived).toBe(coverage.deployedInScope);

      // The floor for THIS assertion: with no in-scope constraints the check
      // above passes vacuously. It is allowed to be small while collections are
      // unplanned, but it must not be zero — the engagement plans alone put
      // `likes` and `bookmarks` against `posts`.
      expect(coverage.deployedInScope).toBeGreaterThan(0);
    } finally {
      await closePostgres();
    }
  });

  it('does NOT count a constraint on a table no plan writes', async () => {
    const db: Database = await connectPostgres();
    try {
      const deployed = await deployedForeignKeys(db);
      const coverage = reconcileRelations(
        referentialRelations(COLLECTION_PLANS),
        deployed,
        plannedTables()
      );

      // WAS `outOfScope > 0`, written while 24 collections were unplanned, when
      // a relation on an unplanned table was expected to be uncovered and
      // conflating the two would have fired the gate permanently on a state
      // nobody could fix. Every table now has a plan, so that number is legally
      // ZERO and the old assertion inverted into a false alarm the day the work
      // finished — a check that fails on SUCCESS, which gets a gate disabled
      // just as surely as one that cries wolf.
      //
      // Two things survive the change of state, and both are asserted because
      // neither implies the other. The COUNT is derived from the same source the
      // scope decision is made from, so it holds at 24 collections or at none
      // and it still fails if the derivation breaks — `toBeGreaterThanOrEqual(0)`
      // would be true of every possible value, which is the vacuous form of this
      // same repair. The PARTITION is the structural half: every deployed
      // constraint is in scope or out of it, exactly once.
      // Two ways a table can be outside the backfill's scope, and the second one
      // is permanent. `tablesWithoutAPlan()` is the work-in-progress set, empty
      // since the plans landed. `TABLES_WITH_NO_MONGO_SOURCE` is a table that
      // shipped AFTER the cutover and therefore never had a source to derive a
      // relation from — so "every deployed constraint is in scope" stopped being
      // true the first time one arrived, and asserting it would now fail on a
      // correct schema rather than on a broken derivation.
      const outsideScope = new Set([
        ...tablesWithoutAPlan(),
        ...TABLES_WITH_NO_MONGO_SOURCE.map((entry) => entry.table),
      ]);
      const expectedOutOfScope = deployed.filter((relation) =>
        outsideScope.has(relation.tableName)
      ).length;
      expect(coverage.outOfScope).toBe(expectedOutOfScope);
      expect(coverage.outOfScope + coverage.deployedInScope).toBe(deployed.length);
      // The floor, restated for a partition that is no longer all on one side: a
      // derivation that shoved every constraint out of scope would satisfy the
      // sum above and mean nothing, so the in-scope side must be non-empty AND
      // the out-of-scope side must be exactly the post-cutover tables' — not
      // merely "some number that happens to add up".
      expect(coverage.deployedInScope).toBeGreaterThan(0);
      expect(coverage.deployedInScope).toBe(deployed.length - expectedOutOfScope);
    } finally {
      await closePostgres();
    }
  });
});

describe('reconcileRelations', () => {
  it('reports a deployed in-scope constraint the derivation missed', () => {
    const coverage = reconcileRelations(
      [],
      [deployedFixture('bfc_a_fk', 'bfc_child')],
      new Set(['bfc_child'])
    );
    expect(coverage.deployedInScope).toBe(1);
    expect(coverage.derived).toBe(0);
    expect(coverage.missing.map((relation) => relation.constraint)).toEqual(['bfc_a_fk']);
  });

  it('leaves an out-of-scope constraint alone', () => {
    const coverage = reconcileRelations([], [deployedFixture('bfc_b_fk', 'bfc_unplanned')], new Set());
    expect(coverage.deployedInScope).toBe(0);
    expect(coverage.missing).toEqual([]);
    expect(coverage.outOfScope).toBe(1);
  });

  it('compares by CONSTRAINT NAME, which is what a 23503 carries', () => {
    // Same child and target table, different name: still missing. A comparison
    // on the table pair would call this covered and the report would name a
    // constraint the operator's error does not.
    const derived = referentialRelations([]);
    const coverage = reconcileRelations(
      derived,
      [deployedFixture('bfc_renamed_fk', 'bfc_child')],
      new Set(['bfc_child'])
    );
    expect(coverage.missing.map((relation) => relation.constraint)).toEqual(['bfc_renamed_fk']);
  });
});

describe('the vacuity floor', () => {
  it('refuses a report whose derivation missed an in-scope constraint', () => {
    expect(() =>
      assertNotVacuous(
        reportWith({
          deployedInScope: 3,
          derived: 2,
          missing: [deployedFixture('bfc_missing_fk', 'bfc_child')],
          outOfScope: 9,
        })
      )
    ).toThrow(VacuousReferentialIntegrityError);
  });

  it('names the constraint, so the message is actionable without the code', () => {
    let thrown: unknown;
    try {
      assertNotVacuous(
        reportWith({
          deployedInScope: 3,
          derived: 2,
          missing: [deployedFixture('bfc_missing_fk', 'bfc_child')],
          outOfScope: 9,
        })
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain('bfc_missing_fk');
    expect((thrown as Error).message).toContain('bfc_child');
    expect((thrown as Error).message).toContain('2 of 3');
  });

  it('accepts a report with complete in-scope coverage', () => {
    expect(() =>
      assertNotVacuous(
        reportWith({ deployedInScope: 3, derived: 3, missing: [], outOfScope: 9 })
      )
    ).not.toThrow();
  });

  it('accepts a report with NO in-scope constraints at all', () => {
    // Legitimate for a plan set whose tables carry no foreign key. The floor
    // that catches an empty derivation is `relationsInspected === 0`, which is a
    // different question and is asserted separately.
    expect(() =>
      assertNotVacuous(
        reportWith({ deployedInScope: 0, derived: 0, missing: [], outOfScope: 42 })
      )
    ).not.toThrow();
  });
});
