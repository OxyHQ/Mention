/**
 * Does every column a plan's table declares actually RECEIVE anything?
 *
 * ## The gap this closes, and why it survived a green run
 *
 * A complete, exit-0, audit-clean rehearsal of 4,986,482 rows silently dropped
 * ELEVEN columns that hold real values in production: eight on `trending`,
 * `federated_actors.network_acct` (135 rows — the field the cross-protocol
 * identity merge matches bridged actors by), and `posts.lane_id` /
 * `posts.written_by_oxy_user_id`. Migration `0006_trend_labels_and_bridged_identity`
 * added most of them; no plan was ever extended to feed them. The schema moved
 * and the plans did not.
 *
 * Nothing caught it, and the reason is exact: **the existing checks count ROWS
 * per document, not COLUMNS per row.** A column that is never written produces
 * exactly one row per document and passes every one of them. `47/47` foreign-key
 * coverage and the per-plan row-cardinality check were both TRUE and both
 * structurally blind — they measure a different property than a reader assumes.
 *
 * ## Why "is it ever non-null" is not the check
 *
 * The obvious version — flag a column that is 100% NULL — has the same shape of
 * blindness one layer down. It cannot see a column that is PARTIALLY written: a
 * plan that maps a field but drops it under some condition turns 548 source
 * values into 300 written ones, and every all-null assertion still passes.
 *
 * So a column may declare {@link ColumnCoverage.sourcePath}, and the check then
 * compares COUNTS — how many source documents hold a value against how many
 * emitted rows carry one. A threshold, not a boolean. Where no source path is
 * declared, the check falls back to "never populated at all", which is strictly
 * weaker and says so.
 *
 * ## The comparison runs in BOTH directions, and the other one is worse
 *
 * Under-population is missing data and it is visible as missing. OVER-population
 * is a column filled for more rows than the source has values for — a mapping
 * that answers `?? ''` or `?? false` where the source held nothing — and it is
 * strictly more dangerous, because a NULL is obviously absent whereas a
 * fabricated constant is confidently wrong. 134 such fallbacks exist across the
 * plans today; most are correct (a counter with no source field genuinely is
 * zero) and that is exactly why the check REPORTS rather than refuses, with
 * {@link ColumnCoverage.filledWhenAbsent} as the written answer.
 *
 * The related shape this check is measured against, because it is the one the
 * sweep that found the eleven structurally could not see: **a column with a
 * DEFAULT that no plan feeds is never NULL in the target.** `copyRowsInto`
 * builds its `INSERT` column list from the properties PRESENT in the rows
 * (`groupByColumnSet`), so a column no row carries is omitted from the statement
 * entirely and Postgres supplies the default on every row. A database-side
 * "which columns are 100% NULL" query cannot see it; this check can, because it
 * counts what the TRANSFORM emitted, not what the table ended up holding. The
 * `NOT NULL DEFAULT` half of that class belongs to `auditDefaultedColumns`,
 * which counts the rows a transform omits a defaulted property for; the NULLABLE
 * half — `column.notNull` is false, `hasDefault` is true — was checked by
 * neither, and lands here as `never-populated`.
 *
 * ## The three states a nullable column may be in
 *
 * Every nullable, non-generated column must be one of:
 *
 *  1. **Observed** — the transform populates it for at least one row (and, with
 *     a `sourcePath`, for as many rows as the source has values).
 *  2. **Declared unmapped** — named in the plan's `unmappedColumns` WITH a
 *     reason. `post_media.mime` is the honest example: zero of 121,135
 *     media-bearing posts carry `content.media.mimeType` in the source, so
 *     nothing can populate it and the reason says so.
 *  3. **A finding.**
 *
 * That is deliberately the same shape as `defaultedColumns` in `audit.ts`,
 * including its stale-acknowledgement half: a declaration that stops being true
 * is reported, because an exemption nobody re-measures is how a gate becomes a
 * formality.
 */

import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import { sqlColumnName } from '../casing';
import { tableName } from './plan';

/** A column the plan states it cannot populate, and why. */
export interface UnmappedColumnAcknowledgement {
  readonly table: PgTable;
  readonly column: PgColumn;
  /**
   * Why nothing can fill it. "The source has no such field" is a reason; "we
   * did not get to it" is a finding wearing a reason's clothes.
   */
  readonly reason: string;
}

/** How many source documents hold a value, for a column that declares a path. */
export interface ColumnCoverage {
  readonly table: PgTable;
  readonly column: PgColumn;
  /** Dotted path into the source document, for the count comparison. */
  readonly sourcePath: string;
  /**
   * Why the column carries a value for rows the source has NO value for — a
   * `?? 0` fallback, or a value derived from something other than this path.
   *
   * Declaring it suppresses the `over-populated` finding for this column, and
   * that is the whole of its effect: it is the written answer to "you are
   * inventing this value", not a way to silence the comparison. Unlike
   * `unmappedColumns` this one is NOT re-measured for rot, and deliberately: a
   * fallback that never fires because every document happens to hold a value is
   * inert, not wrong, and reporting it would be the check crying wolf.
   */
  readonly filledWhenAbsent?: string;
}

/** What one pass observed: per table, per column, how many rows carried a value. */
export type PopulatedCounts = Map<string, Map<string, number>>;

/**
 * Does this document hold a value at a dotted path?
 *
 * Deliberately NOT `values.at()`, which stops at an array: a segment applied to
 * one returns `undefined`, so `content.media.url` would read as absent on every
 * document and every child-table declaration would land in the typo case. This
 * descends into arrays and asks whether ANY element yields a value, which is
 * the same semantics Mongo's own dotted-path matching applies — and it is what
 * makes the count comparable to a `countDocuments` on the same path.
 */
export function holdsValueAt(document: unknown, path: string): boolean {
  return valueSeenAt(document, path.split('.'), 0);
}

function valueSeenAt(value: unknown, segments: readonly string[], index: number): boolean {
  if (value === null || value === undefined) return false;
  if (index === segments.length) return true;
  if (Array.isArray(value)) {
    return value.some((element) => valueSeenAt(element, segments, index));
  }
  if (typeof value !== 'object') return false;
  const segment = segments[index];
  if (segment === undefined) return false;
  return valueSeenAt((value as Record<string, unknown>)[segment], segments, index + 1);
}

/** Accumulate a column's populated count from an emitted row. */
export function recordPopulated(
  counts: PopulatedCounts,
  table: PgTable,
  row: Record<string, unknown>
): void {
  const name = tableName(table);
  let byColumn = counts.get(name);
  if (!byColumn) {
    byColumn = new Map();
    counts.set(name, byColumn);
  }
  for (const [property, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    byColumn.set(property, (byColumn.get(property) ?? 0) + 1);
  }
}

/** One column the copy would leave empty, or fill less than the source holds. */
export interface CoverageFinding {
  readonly collection: string;
  readonly table: string;
  readonly column: string;
  readonly kind:
    | 'never-populated'
    | 'partially-populated'
    /**
     * Filled for MORE rows than the source holds values — a fabricated
     * constant. Only assertable on the plan's primary table, where the contract
     * is one row per document and the two counts are therefore in the same
     * unit; see the note in {@link auditColumnCoverage}.
     */
    | 'over-populated'
    | 'stale-acknowledgement'
    /**
     * A declared `sourcePath` that matches NOTHING. Not a finding about the
     * data — the field may genuinely be absent from this corpus — and not
     * clean either, because it is exactly what a typo looks like.
     */
    | 'declared-never-observed';
  readonly sourceValues: number | null;
  readonly populated: number;
  readonly detail: string;
}

/**
 * Every nullable column a plan writes that nothing fills.
 *
 * ## The two counts are only in the same UNIT on the primary table
 *
 * `sourceCounts` counts DOCUMENTS holding a value; `populated` counts emitted
 * ROWS carrying one. `CollectionPlan.table` is documented as "one row per
 * document", so on that table the two are directly comparable and a surplus is
 * real. A child table is filled from a subdocument ARRAY, so one document
 * routinely produces several rows and `populated > sourceValues` is the normal
 * case rather than a finding — over-population is therefore not asserted there.
 * Under-population stays sound on both: a document holding a value at the path
 * emits at least one row carrying it, so a shortfall is a shortfall either way.
 *
 * @param populated What the pass observed, keyed by table then by the column's
 *   TypeScript property name — which is what an emitted row is keyed by.
 * @param sourceCounts Populated counts from the SOURCE for columns that declare
 *   a `sourcePath`. Absent entries fall back to the weaker never-populated test.
 * @param primaryTable The plan's `table`. Only its columns can be checked for
 *   over-population, for the unit reason above.
 */
export function auditColumnCoverage(input: {
  readonly collection: string;
  readonly primaryTable: PgTable;
  readonly tables: readonly PgTable[];
  readonly populated: PopulatedCounts;
  readonly unmapped?: readonly UnmappedColumnAcknowledgement[];
  readonly coverage?: readonly ColumnCoverage[];
  readonly sourceCounts?: ReadonlyMap<string, number>;
  /** Rows the pass read, so a plan that emitted nothing is not reported as 30 gaps. */
  readonly rowsEmitted: number;
}): CoverageFinding[] {
  // A pass that emitted no rows tells us nothing about coverage. Reporting every
  // column of an empty collection would bury the real findings under noise —
  // the same "cries wolf and gets disabled" failure the vacuity floors exist for.
  if (input.rowsEmitted === 0) return [];

  const acknowledged = new Map<string, string>();
  for (const entry of input.unmapped ?? []) {
    acknowledged.set(`${tableName(entry.table)}.${entry.column.name}`, entry.reason);
  }
  const declaredPaths = new Map<string, string>();
  const filledWhenAbsent = new Map<string, string>();
  for (const entry of input.coverage ?? []) {
    const key = `${tableName(entry.table)}.${entry.column.name}`;
    declaredPaths.set(key, entry.sourcePath);
    if (entry.filledWhenAbsent !== undefined) {
      filledWhenAbsent.set(key, entry.filledWhenAbsent);
    }
  }
  const primary = tableName(input.primaryTable);

  const findings: CoverageFinding[] = [];
  const seen = new Set<string>();

  for (const table of input.tables) {
    const name = tableName(table);
    const observed = input.populated.get(name);
    // A table this plan never emitted a row for is not evidence about its
    // columns — the plan may simply have had no documents of that shape.
    if (!observed || observed.size === 0) continue;

    for (const [property, column] of Object.entries(getTableColumns(table))) {
      const key = `${name}.${property}`;
      // A NOT NULL column cannot be "never populated" — the row carries a value
      // or the insert fails — so with nothing declared there is nothing here to
      // say, and `auditDefaultedColumns` owns the omission half of that class.
      //
      // But it does NOT own the disguise: a transform answering `?? false` or
      // `?? 0` SUPPLIES the property, so nothing is omitted, no finding is
      // raised, and the column holds one fabricated constant on every row. 78
      // columns are in exactly that state in the rehearsed corpus. Declaring a
      // `sourcePath` on a NOT NULL column is how that gets measured rather than
      // assumed, so a declared column stays in scope whatever its nullability.
      if (column.notNull && !declaredPaths.has(key)) continue;
      const sqlName = `${name}.${sqlColumnName(column)}`;
      const populated = observed.get(property) ?? 0;
      const sourcePath = declaredPaths.get(key);
      const sourceValues = sourcePath === undefined
        ? null
        : input.sourceCounts?.get(sourcePath) ?? null;

      if (acknowledged.has(key)) {
        seen.add(key);
        if (populated > 0) {
          findings.push({
            collection: input.collection,
            table: name,
            column: sqlName,
            kind: 'stale-acknowledgement',
            sourceValues,
            populated,
            detail:
              `${sqlName} is declared in \`unmappedColumns\` ("${acknowledged.get(key)}") ` +
              `but the transform populates it for ${populated} row(s). The ` +
              'declaration describes behaviour that no longer happens — remove ' +
              'it, because an exemption nobody re-measures is how this gate ' +
              'turns into a formality.',
          });
        }
        // THE ROT CASE, and the one an allowlist that only grows will hit.
        // A declaration reading "the source has no such field" is a claim about
        // the SOURCE, and the source keeps moving. If it later gains values and
        // nothing writes the column, the acknowledgement is no longer an
        // exception — it is excusing live data loss, silently, with a comment
        // over it. Only reachable when a `sourcePath` was declared, which is
        // why an acknowledged column is worth giving one.
        if (populated === 0 && sourceValues !== null && sourceValues > 0) {
          findings.push({
            collection: input.collection,
            table: name,
            column: sqlName,
            kind: 'stale-acknowledgement',
            sourceValues,
            populated: 0,
            detail:
              `${sqlName} is declared in \`unmappedColumns\` ("${acknowledged.get(key)}") ` +
              `but the source now holds ${sourceValues} value(s) at \`${sourcePath}\` ` +
              'and nothing writes the column. The reason has stopped being true, ' +
              'so the declaration is excusing real data loss rather than ' +
              'describing an absence. Map the column or rewrite the reason.',
          });
        }
        continue;
      }

      // THE VACUITY CASE — checked AFTER the acknowledgement above, not before.
      // A column that is DECLARED unmapped because the source has no such field,
      // and whose path then matches nothing, is the declaration being
      // CORROBORATED; reporting it there would turn every honest
      // acknowledgement into a typo warning. This is for a column nobody
      // acknowledged, where the path is what was supposed to prove coverage.
      // A `sourcePath` with a typo — or naming a field Mongo renamed years ago —
      // finds zero source documents, and a check comparing counts then sees
      // 0 = 0 and reports agreement. It reads exactly like a column that is
      // legitimately empty, which is the same green-result-standing-in-for-an-
      // answer that let eleven dropped columns through in the first place.
      //
      // So it gets its own state rather than a verdict: the path is named, and
      // the message says outright that this is indistinguishable from a typo.
      // Confirming the field really is absent is a human's job; making the
      // question visible is this check's.
      if (sourcePath !== undefined && sourceValues === 0) {
        seen.add(key);
        findings.push({
          collection: input.collection,
          table: name,
          column: sqlName,
          kind: 'declared-never-observed',
          sourceValues: 0,
          populated,
          detail:
            `${sqlName} declares its source as \`${sourcePath}\`, and NO source ` +
            'document holds a value there. That is what a mistyped or renamed ' +
            'path looks like, and it is also what a genuinely absent field looks ' +
            'like — the two are indistinguishable from here, so this is reported ' +
            'rather than passed. Confirm the path against a real document, then ' +
            'either correct it or move the column to `unmappedColumns` with the ' +
            'reason the field is gone.',
        });
        continue;
      }

      if (populated === 0) {
        findings.push({
          collection: input.collection,
          table: name,
          column: sqlName,
          kind: 'never-populated',
          sourceValues,
          populated: 0,
          detail:
            `${sqlName} is nullable and NOTHING the transform emits ever fills ` +
            `it, across ${input.rowsEmitted} row(s)` +
            (sourceValues === null
              ? '. No `sourcePath` is declared for it, so this cannot say whether ' +
                'the source holds values — declare one, or acknowledge the column ' +
                'in `unmappedColumns` with the reason nothing can fill it.'
              : `, while ${sourceValues} source document(s) hold a value at ` +
                `\`${sourcePath}\`. Those values are being DROPPED.`),
        });
        continue;
      }

      // The half an all-null test cannot see: mapped, but not for every row the
      // source has a value for.
      if (sourceValues !== null && populated < sourceValues) {
        findings.push({
          collection: input.collection,
          table: name,
          column: sqlName,
          kind: 'partially-populated',
          sourceValues,
          populated,
          detail:
            `${sqlName} is filled for ${populated} row(s) but ${sourceValues} ` +
            `source document(s) hold a value at \`${sourcePath}\` — ${sourceValues - populated} ` +
            'are being dropped. A column that is partly written passes every ' +
            '"is it ever non-null" test, which is why the comparison is a COUNT.',
        });
        continue;
      }

      // THE OTHER DIRECTION, and the one no all-null sweep can ever reach: the
      // column is filled for rows the source has NOTHING for. A `?? ''` or
      // `?? false` fallback does this, and so does a column left to a database
      // DEFAULT — both produce a value nobody chose, on every row, with no
      // error and nothing missing to notice. Under-population is visibly absent
      // data; this is confidently wrong data, which is worse.
      //
      // Restricted to the primary table because only there are the two counts
      // in the same unit (see the note above), and suppressed by an explicit
      // `filledWhenAbsent` — a counter with no source field genuinely is zero,
      // and the point is to make somebody write that down once.
      if (
        sourceValues !== null &&
        populated > sourceValues &&
        name === primary &&
        !filledWhenAbsent.has(key)
      ) {
        findings.push({
          collection: input.collection,
          table: name,
          column: sqlName,
          kind: 'over-populated',
          sourceValues,
          populated,
          detail:
            `${sqlName} is filled for ${populated} row(s) but only ${sourceValues} ` +
            `source document(s) hold a value at \`${sourcePath}\` — ${populated - sourceValues} ` +
            'row(s) carry a value the source did not supply. A fabricated ' +
            'constant is not a missing value: it passes every null check and ' +
            'reads as real data. If the fallback is correct, say so in ' +
            '`filledWhenAbsent`; if it is not, the column should be NULL there.',
        });
      }
    }
  }

  // The stale half, for a declaration naming a column the table no longer has.
  for (const [key, reason] of acknowledged) {
    if (seen.has(key)) continue;
    const [table] = key.split('.');
    findings.push({
      collection: input.collection,
      table: table ?? '(unknown)',
      column: key,
      kind: 'stale-acknowledgement',
      sourceValues: null,
      populated: 0,
      detail:
        `${key} carries an \`unmappedColumns\` acknowledgement ("${reason}") but ` +
        'no such nullable column was inspected on that table — the column was ' +
        'renamed or removed, and the declaration now describes nothing.',
    });
  }

  return findings;
}
