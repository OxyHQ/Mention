/**
 * Insert order and self-reference deferral, DERIVED from the real foreign keys.
 *
 * Parents before children, and the graph is real now — Postgres refuses a
 * violation rather than tolerating it silently, which is the whole reason the
 * relational port was worth doing.
 *
 * Nothing here is hand-written. A declared order would be a second source of
 * truth for the same fact and would drift the first time a foreign key was
 * added; the topological sort reads `getTableConfig(table).foreignKeys` and
 * cannot. The measured graph over this schema's 73 tables is a DAG once
 * self-references are set aside — 47 tables have no foreign key at all and the
 * rest form a shallow tree under `posts` — which is why a single ordered pass
 * works and why the levels come out wide enough to be worth running
 * concurrently.
 *
 * ## Self-references need a second pass, and there is no way around it
 *
 * `posts.parent_post_id` is the ONLY self-reference in this schema, and it is
 * the one that matters most: a reply is a `posts` row pointing at another
 * `posts` row, and Postgres checks that foreign key IMMEDIATELY unless the
 * constraint is declared `DEFERRABLE`, which it is not. A reply whose parent
 * sorts later by `_id` therefore fails on insert — and that is routine rather
 * than theoretical, because a federated reply's import-time `_id` bears no
 * relation to the parent's (the same fact that makes an `_id` sort wrong for
 * the author feed).
 *
 * So the copy inserts every self-referencing column as NULL and a second pass
 * UPDATEs them once every row exists. The columns to defer are derived here
 * too, so adding a self-reference to the schema is picked up without touching
 * this file.
 *
 * The alternative — sorting each collection topologically by its own parent
 * pointers — was rejected: it needs the whole collection in memory to compute,
 * which is exactly what batching exists to avoid, and it cannot handle a cycle
 * (a thread whose root was deleted and re-pointed) at all.
 */

import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { CollectionPlan } from './plan';
import { planTables, tableName } from './plan';

/** A table's self-referencing columns, by TypeScript property name. */
export interface SelfReference {
  readonly table: PgTable;
  /** Column property names to insert as NULL and fill in the second pass. */
  readonly columns: readonly string[];
}

/** Property names of the columns in `table` that reference `table` itself. */
export function selfReferencingColumns(table: PgTable): string[] {
  const config = getTableConfig(table);
  const columns = new Set<string>();
  for (const foreignKey of config.foreignKeys) {
    const reference = foreignKey.reference();
    if (!is(reference.foreignTable, PgTable)) continue;
    if (getTableConfig(reference.foreignTable).name !== config.name) continue;
    for (const column of reference.columns) columns.add(column.name);
  }
  return [...columns].sort();
}

/** Tables the given plans write to that reference themselves. */
export function selfReferences(plans: readonly CollectionPlan[]): SelfReference[] {
  const seen = new Set<string>();
  const out: SelfReference[] = [];
  for (const plan of plans) {
    for (const table of planTables(plan)) {
      const name = tableName(table);
      if (seen.has(name)) continue;
      seen.add(name);
      const columns = selfReferencingColumns(table);
      if (columns.length > 0) out.push({ table, columns });
    }
  }
  return out.sort((a, b) => tableName(a.table).localeCompare(tableName(b.table)));
}

/** Raised when the foreign-key graph cannot be ordered. */
export class ForeignKeyCycleError extends Error {
  constructor(readonly tables: readonly string[]) {
    super(
      'The foreign-key graph has a cycle that is not a self-reference, so no ' +
        'single-pass insert order exists. Tables still unresolved: ' +
        `${tables.join(', ')}. Break the cycle by deferring one edge to the ` +
        'second pass, the way self-references already are.'
    );
    this.name = 'ForeignKeyCycleError';
  }
}

/**
 * The insert order, expressed as LEVELS: every plan in a level depends only on
 * plans in earlier levels, so a level's plans can run CONCURRENTLY.
 *
 * `posts` is by far the largest collection and everything under it — the ten
 * child tables, plus `likes`, `bookmarks`, `polls`, `articles` and the rest —
 * has to wait for it. Levels are what let the dozens of collections that depend
 * on NOTHING (`notifications`, `federated_actors`, `user_settings`,
 * `mention_signed_records`, …) run alongside it instead of behind it, without
 * weakening the parents-before-children rule at all: the rule is BETWEEN
 * levels, and within a level there is by construction no dependency to violate.
 *
 * A flat ordered list cannot express that, which is why there is no second
 * "just give me the order" function here: running a flat list concurrently
 * would be a race, and running it serially wastes the whole connection pool on
 * one cursor at a time. Flattening THIS result gives a valid total order for
 * anything that wants one, so the two would have been the same sort written
 * twice — and a duplicated topological sort is a duplicated place to be wrong.
 *
 * @throws {ForeignKeyCycleError} When a non-self-referencing cycle exists.
 */
export function planLevels(plans: readonly CollectionPlan[]): CollectionPlan[][] {
  const producedBy = new Map<string, CollectionPlan>();
  for (const plan of plans) {
    for (const table of planTables(plan)) producedBy.set(tableName(table), plan);
  }

  const dependencies = new Map<CollectionPlan, Set<CollectionPlan>>();
  for (const plan of plans) {
    const own = new Set(planTables(plan).map(tableName));
    const needs = new Set<CollectionPlan>();
    for (const table of planTables(plan)) {
      for (const foreignKey of getTableConfig(table).foreignKeys) {
        const target = foreignKey.reference().foreignTable;
        if (!is(target, PgTable)) continue;
        const targetName = getTableConfig(target).name;
        if (own.has(targetName)) continue;
        const producer = producedBy.get(targetName);
        if (producer && producer !== plan) needs.add(producer);
      }
    }
    dependencies.set(plan, needs);
  }

  const levels: CollectionPlan[][] = [];
  const placed = new Set<CollectionPlan>();
  while (placed.size < plans.length) {
    const level = plans.filter(
      (plan) =>
        !placed.has(plan) &&
        [...(dependencies.get(plan) ?? [])].every((dependency) => placed.has(dependency))
    );
    if (level.length === 0) {
      throw new ForeignKeyCycleError(
        plans.filter((plan) => !placed.has(plan)).map((plan) => plan.collection)
      );
    }
    for (const plan of level) placed.add(plan);
    levels.push(level);
  }
  return levels;
}
