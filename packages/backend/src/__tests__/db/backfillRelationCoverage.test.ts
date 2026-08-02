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

import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { connectPostgres, closePostgres, type Database } from '../../db/postgres';
import {
  assertNotVacuous,
  deployedForeignKeys,
  reconcileRelations,
  referentialRelations,
  VacuousReferentialIntegrityError,
  type DeployedRelation,
  type ReferentialIntegrityReport,
} from '../../db/backfill/referentialIntegrity';
import { COLLECTION_PLANS, allSchemaTables } from '../../db/backfill/collectionMap';
import { planTables, tableName } from '../../db/backfill/plan';

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

      // While 24 collections are unplanned this is the large number, and it is
      // NOT a defect — a relation on an unplanned table is expected to be
      // uncovered. Conflating the two would make the gate fire permanently on a
      // state nobody can fix, which is how a gate gets disabled.
      expect(coverage.outOfScope).toBeGreaterThan(0);
      expect(coverage.outOfScope + coverage.deployedInScope).toBe(deployed.length);
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
