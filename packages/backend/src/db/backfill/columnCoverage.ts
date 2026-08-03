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
}

/** What one pass observed: per table, per column, how many rows carried a value. */
export type PopulatedCounts = Map<string, Map<string, number>>;

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
  readonly kind: 'never-populated' | 'partially-populated' | 'stale-acknowledgement';
  readonly sourceValues: number | null;
  readonly populated: number;
  readonly detail: string;
}

/**
 * Every nullable column a plan writes that nothing fills.
 *
 * @param populated What the pass observed, keyed by table then by the column's
 *   TypeScript property name — which is what an emitted row is keyed by.
 * @param sourceCounts Populated counts from the SOURCE for columns that declare
 *   a `sourcePath`. Absent entries fall back to the weaker never-populated test.
 */
export function auditColumnCoverage(input: {
  readonly collection: string;
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
  for (const entry of input.coverage ?? []) {
    declaredPaths.set(`${tableName(entry.table)}.${entry.column.name}`, entry.sourcePath);
  }

  const findings: CoverageFinding[] = [];
  const seen = new Set<string>();

  for (const table of input.tables) {
    const name = tableName(table);
    const observed = input.populated.get(name);
    // A table this plan never emitted a row for is not evidence about its
    // columns — the plan may simply have had no documents of that shape.
    if (!observed || observed.size === 0) continue;

    for (const [property, column] of Object.entries(getTableColumns(table))) {
      if (column.notNull) continue;
      const key = `${name}.${property}`;
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
