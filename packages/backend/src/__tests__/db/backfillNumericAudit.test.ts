/**
 * The numeric audit — the class of CHECK an `EnumAudit` structurally cannot see.
 *
 * `EnumAudit` reads its accepted set from `column.enumValues`, which only a text
 * column carries, so before `auditNumerics` existed roughly forty CHECKs in this
 * schema were unaudited. They are not exotic: most are `>= 0` on a denormalized
 * counter copied straight out of Mongo, where Mongoose's `min:` never ran
 * (`runValidators` is set nowhere in this package) and a decrement race is the
 * ordinary way an integer ends up out of range. A negative counter is a `23514`
 * naming a constraint, hours into a run, with no row in the message.
 *
 * Three properties are asserted, and each fails differently when broken:
 *
 * 1. A violating value is FOUND, with its count and sample ids.
 * 2. A legal value is NOT reported. A gate that cries wolf gets disabled by
 *    whoever hits it next, so the false-positive cases carry as much weight as
 *    the true-positive ones — especially the NULL branches, where a nullable
 *    column legitimately accepts NULL (`NULL >= 0` is NULL, and a CHECK is
 *    satisfied by anything that is not FALSE).
 * 3. An audit that constrains NOTHING throws rather than passing. A vacuous
 *    check reads exactly like coverage and is worse than no check at all.
 *
 * The live source is stubbed rather than mocked through a module boundary: the
 * unit under test is the decision, and a stub whose `distinct` returns a chosen
 * value set is the whole input. Every fixture id is scoped to this file, since
 * vitest runs files in parallel against one database.
 */

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { auditNumerics, auditWouldBlockCopy } from '../../db/backfill/audit';
import type { MongoSource, ReadOnlyCollection } from '../../db/backfill/mongoSource';
import { describeNumericBound, numericIsAccepted, type CollectionPlan } from '../../db/backfill/plan';
import { LIKE_VALUES, likes } from '../../db/schema/engagement';
import { trending } from '../../db/schema/discovery';
import { numericInList } from '../../db/schema/columns';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { runAudits } from '../../db/backfill/runner';
import {
  createResolutionContext,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';

/**
 * A source whose real behaviour is the value set `distinct` returns — plus how
 * many documents LACK the field entirely, which is a different question.
 *
 * The two have to be answerable apart, because Mongo answers them apart:
 * `distinct` omits a missing field rather than reporting it as `null`, so the
 * audit probes for it with a separate `{$exists: false}` count. A stub whose
 * `countDocuments` ignored its filter would answer both with the same number and
 * report a phantom missing-field finding on every case here — which is exactly
 * what the first version did.
 */
function stubSource(values: readonly unknown[], documents = 3, missing = 0): MongoSource {
  const isMissingProbe = (filter: unknown): boolean =>
    JSON.stringify(filter ?? {}).includes('$exists');
  const collection = {
    distinct: async () => [...values],
    countDocuments: async (filter: unknown) => (isMissingProbe(filter) ? missing : documents),
    find: (filter: unknown) => ({
      toArray: async () => {
        const count = isMissingProbe(filter) ? missing : documents;
        return Array.from({ length: Math.min(count, 5) }, (_, index) => ({
          _id: `numaudit-${index}`,
        }));
      },
    }),
  } as unknown as ReadOnlyCollection;
  return {
    collection: () => collection,
    listCollections: async () => [],
    count: async () => documents,
    close: async () => undefined,
  } as unknown as MongoSource;
}

/** A plan carrying one numeric audit and a transform nothing here calls. */
function planWith(numericAudits: NonNullable<CollectionPlan['numericAudits']>): CollectionPlan {
  return {
    collection: 'numaudit_fixture',
    table: likes,
    numericAudits,
    transform: () => {
      throw new Error('the numeric audit must never run a transform');
    },
  };
}

const likeValueAudit = {
  path: 'value',
  column: likes.value,
  constraint: 'likes_value_check',
  values: LIKE_VALUES,
  absentAs: 1,
} as const;

describe('auditNumerics — closed sets', () => {
  it('reports a value the CHECK would refuse, with its count and sample ids', async () => {
    const findings = await auditNumerics(stubSource([1, -1, 0]), planWith([likeValueAudit]));

    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('numeric');
    expect(findings[0].detail).toContain('likes_value_check');
    expect(findings[0].detail).toContain('one of 1, -1');
    expect(findings[0].documents).toBe(3);
    expect(findings[0].sampleIds.length).toBeGreaterThan(0);
  });

  it('blocks the copy — a 23514 is refused before the run, not during it', async () => {
    const findings = await auditNumerics(stubSource([0]), planWith([likeValueAudit]));
    expect(findings.map(auditWouldBlockCopy)).toEqual([true]);
  });

  it('reports nothing when every observed value is in the set', async () => {
    const findings = await auditNumerics(stubSource([1, -1]), planWith([likeValueAudit]));
    expect(findings).toEqual([]);
  });

  it('refuses a string where a number belongs', async () => {
    const findings = await auditNumerics(stubSource(['1']), planWith([likeValueAudit]));
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('string');
  });

  it('refuses NaN and Infinity, which no numeric column can hold', async () => {
    const findings = await auditNumerics(
      stubSource([Number.NaN, Number.POSITIVE_INFINITY]),
      planWith([likeValueAudit])
    );
    expect(findings).toHaveLength(2);
  });
});

describe('auditNumerics — bounds', () => {
  const revisionAudit = {
    path: 'revision',
    column: likes.revision,
    constraint: 'likes_revision_check',
    min: 0,
  } as const;

  it('reports a value below the lower bound', async () => {
    const findings = await auditNumerics(stubSource([0, 1, 4, -1]), planWith([revisionAudit]));
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('>= 0');
  });

  /**
   * The bound is `>= 0` and NOT the model's stricter `min: 1`. Legacy rows start
   * at zero and take revision 1 on their next transition, which is why the CHECK
   * was widened — an audit holding the model's claim instead would report every
   * one of those rows as blocking.
   */
  it('accepts zero, which the model forbids and the CHECK deliberately allows', async () => {
    const findings = await auditNumerics(stubSource([0]), planWith([revisionAudit]));
    expect(findings).toEqual([]);
  });

  it('reports a value above an upper bound', async () => {
    const findings = await auditNumerics(
      stubSource([0, 0.5, 1, 1.5]),
      planWith([
        {
          path: 'weight',
          column: likes.revision,
          constraint: 'user_behavior_authors_weight_check',
          min: 0,
          max: 1,
        },
      ])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('between 0 and 1');
  });
});

describe('auditNumerics — the NULL branches', () => {
  it('does NOT report a null in a nullable column', async () => {
    // `NULL >= 0` is NULL, and a CHECK is satisfied by anything that is not
    // FALSE, so Postgres accepts the row. Reporting it would be a false
    // positive on every optional numeric field in the schema.
    expect(trending.volume.notNull).toBe(true);
    const nullableColumn = likes.source;
    expect(nullableColumn.notNull).toBe(false);

    const findings = await auditNumerics(
      stubSource([null, 3]),
      planWith([
        { path: 'optional', column: nullableColumn, constraint: 'fixture_check', min: 0 },
      ])
    );
    expect(findings).toEqual([]);
  });

  it('reports a null in a NOT NULL column with no declared default', async () => {
    const findings = await auditNumerics(
      stubSource([null]),
      planWith([
        { path: 'revision', column: likes.revision, constraint: 'likes_revision_check', min: 0 },
      ])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('NOT NULL');
  });

  it('does NOT report a null the transform declares a default for', async () => {
    const findings = await auditNumerics(stubSource([null]), planWith([likeValueAudit]));
    expect(findings).toEqual([]);
  });

  /**
   * The branch `distinct` cannot reach, and the one that cost a red case to
   * find: Mongo's `distinct` OMITS a missing field rather than returning `null`
   * for it. So a `NOT NULL` column with no default, over documents that never
   * had the field, passed every audit and then threw inside `buildRow`
   * mid-copy — one document, no count, no sample, half a database migrated.
   */
  it('reports a field that is MISSING rather than null', async () => {
    const findings = await auditNumerics(
      // `distinct` sees NOTHING (the field is absent everywhere), and the
      // separate `$exists: false` probe sees four documents.
      stubSource([], 0, 4),
      planWith([
        { path: 'revision', column: likes.revision, constraint: 'likes_revision_check', min: 0 },
      ])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('MISSING');
    expect(findings[0].documents).toBe(4);
    expect(auditWouldBlockCopy(findings[0])).toBe(true);
  });

  it('does NOT probe for a missing field the transform declares a default for', async () => {
    const findings = await auditNumerics(stubSource([], 0, 4), planWith([likeValueAudit]));
    expect(findings).toEqual([]);
  });

  it('does NOT probe for a missing field in a NULLABLE column', async () => {
    const findings = await auditNumerics(
      stubSource([], 0, 4),
      planWith([{ path: 'optional', column: likes.source, constraint: 'fixture_check', min: 0 }])
    );
    expect(findings).toEqual([]);
  });
});

describe('numericIsAccepted — the vacuity floor', () => {
  it('throws for an audit that declares neither a set nor a bound', () => {
    expect(() =>
      numericIsAccepted(
        { path: 'x', column: likes.value, constraint: 'fixture_check' },
        1_000_000
      )
    ).toThrow(/neither an accepted set nor a bound/);
  });

  it('throws for an audit that declares both, since nothing says which wins', () => {
    expect(() =>
      numericIsAccepted(
        { path: 'x', column: likes.value, constraint: 'fixture_check', values: [1], min: 0 },
        1
      )
    ).toThrow(/both an accepted set and a bound/);
  });

  it('describes a bound it cannot evaluate rather than claiming one', () => {
    expect(
      describeNumericBound({ path: 'x', column: likes.value, constraint: 'fixture_check' })
    ).toContain('no constraint');
  });
});

describe('numericInList', () => {
  it('renders unquoted SQL numeric literals', () => {
    expect(numericInList(LIKE_VALUES)).toBe('1, -1');
  });

  it('refuses a non-finite value rather than emitting an identifier', () => {
    // `String(Infinity)` is `Infinity`, which Postgres parses as a COLUMN
    // reference — a syntactically valid CHECK against a column that does not
    // exist, failing at migration time far from its cause.
    expect(() => numericInList([Number.POSITIVE_INFINITY])).toThrow(/not a SQL numeric literal/);
    expect(() => numericInList([Number.NaN])).toThrow(/not a SQL numeric literal/);
  });
});

describe('the runner actually runs it', () => {
  /**
   * Without this, every case above would still pass with `auditNumerics`
   * deleted from `runAudits` — the audit would be correct, tested, and never
   * called, which is the exact shape of a check that answers a narrower
   * question than the one it appears to answer.
   */
  it('surfaces a numeric finding through runAudits, not just through auditNumerics', async () => {
    const plan = planWith([likeValueAudit]);
    const findings = await runAudits(
      await connectPostgres(),
      stubSource([0]),
      { migrated: [{ plan, documents: 3 }], excluded: [], unknown: [], absent: [] },
      createResolutionContext(await planResolutions(stubSource([])), new ResolutionLog())
    );

    expect(findings.findings.some((finding) => finding.kind === 'numeric')).toBe(true);
    // And it blocks, so the referential pass is deliberately NOT run — a clean
    // referential verdict computed over data an earlier audit already refused
    // would be a claim nobody may rely on.
    expect(findings.referentialIntegrity.notRunReason).toBeDefined();
  });
});

describe('the CHECK the audit predicts', () => {
  /**
   * The audit reads `LIKE_VALUES`; the deployed constraint is whatever the
   * applied migration wrote. This asserts they are the same thing — the drift
   * the audit's whole "read, never restate" contract exists to prevent, checked
   * against the LIVE `pg_constraint` definition rather than against the source
   * the audit already agrees with by construction.
   */
  it('matches the constraint actually deployed on likes.value', async () => {
    const db: Database = await connectPostgres();
    try {
      const rows = await db.execute<{ definition: string }>(sql`
        select pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname = 'likes_value_check'
      `);
      expect(rows).toHaveLength(1);
      const definition = rows[0].definition;
      for (const value of LIKE_VALUES) {
        expect(definition).toContain(String(value));
      }
      // A value the tuple does NOT contain must be absent, or "contains 1 and
      // -1" would pass against a constraint that also allowed 0.
      expect(definition).not.toMatch(/\b0\b/);
    } finally {
      await closePostgres();
    }
  });
});
