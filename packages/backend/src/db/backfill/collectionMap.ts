/**
 * THE collection → table map. Every Mongo collection is either mapped or
 * excluded with a reason; there is no third state.
 *
 * `schema/CONVENTIONS.md` names this file's obligation and the reason for it:
 * table names are explicit snake_case and plural (`push_tokens`, not Mongoose's
 * derived `pushtokens`), because the derived name is a `pluralize()` artifact
 * rather than a design. Neither side of this map can therefore be computed from
 * the other, and it has to be written out.
 *
 * ## The collection names are READ, not derived
 *
 * They come from the model registry — `Model.collection.collectionName` on each
 * of the 45 models in `src/models/` — never from a guess at the plural. All
 * three shapes that exist in production are represented:
 *
 * - **Pluralised model name** — the majority.
 *   `AuthorFollowerSnapshot` → `authorfollowersnapshots`.
 * - **An explicit `collection:` option** — `engagement_outbox`,
 *   `moderation_events`, `moderation_outbox`, `moderation_enforcements`,
 *   `post_recent_repliers`, `gifs`. These are NOT the plural and cannot be
 *   derived from the model name at all.
 * - **A collection whose model no longer exists** — `mentionsignedrecords` and
 *   `mentionrepoheads`, whose models the Postgres port itself deleted, plus the
 *   dead `analytics`. These cannot be derived from anything: the code that
 *   named them is gone.
 *
 * The runner therefore treats `db.listCollections()` as the authority and
 * checks it against this map. A live collection appearing in NEITHER list is a
 * HARD FAILURE, not a warning — that is the only mechanism that can notice a
 * collection nobody remembered, which is exactly how data goes missing quietly.
 *
 * ## Exclusions carry a reason, and the reason names the evidence
 *
 * An unexplained exclusion is indistinguishable from an oversight six months
 * later. Every entry below says what retired the collection and where to look.
 */

import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import * as schema from '../schema';
import type { CollectionPlan, ExcludedCollection } from './plan';
import { planTables, tableName } from './plan';

/**
 * Every collection that moves, and what it becomes.
 *
 * EMPTY pending two things, both of which are decisions rather than work:
 *
 * 1. **The seven-collection schema gap.** `drizzle/foundation` branched at
 *    `f4386de5`; `main` has since landed `adminscriptcursors`,
 *    `repairfetchfailures`, `trendsummaries`, `blockeddomainpurges`,
 *    `blockeddomainpurgeruns`, `blocklistproposals` and `blocklistproposalruns`
 *    — live collections with models and writers on `main` and NO table here.
 *    They are not exclusions: `blocklistproposals` and `blockeddomainpurges`
 *    carry hand-made moderation decisions. Until they have tables, a plan for
 *    them cannot be written and `discover()` will (correctly) hard-fail on
 *    them.
 * 2. **A live-collection census.** This map is derived from CODE, and code
 *    cannot see a collection whose writer was deleted — `analytics` below is
 *    the one already known, and a read-only `db.listCollections()` against
 *    `mention-production` is what would find the rest.
 *
 * Writing plans before either is settled would mean guessing, and a plan that
 * is wrong about which table a collection feeds is worse than a missing one:
 * the missing one fails loudly at `discover()`.
 */
export const COLLECTION_PLANS: readonly CollectionPlan[] = [];

/**
 * Every collection that deliberately does NOT move, and why.
 */
export const NOT_MIGRATED: readonly ExcludedCollection[] = [
  // --- bookkeeping for the Mongo-era migration runner -----------------------
  {
    collection: 'migrations',
    reason:
      'The Mongo migration LEDGER (`MIGRATIONS_COLLECTION` in ' +
      'src/migrations/constants.ts) — one document per applied migration id, ' +
      'written by src/migrations/runner.ts. It is bookkeeping ABOUT thirteen ' +
      'index/data migrations that have already run against MongoDB, not ' +
      'application data, and it has no Postgres counterpart: schema changes ' +
      'there are the SQL files in `drizzle/` with their own ledger. Copying it ' +
      'would import a record of work that no longer needs doing, keyed by ids ' +
      '(`0001-repost-to-boost`, …) that mean nothing to a Drizzle schema. ' +
      'MongoDB retains it either way — nothing in this migration deletes from ' +
      'Mongo — so the audit trail is preserved where it is.',
  },
  {
    collection: 'migration_leases',
    reason:
      'The fencing LEASE for that same runner (`MIGRATION_LEASE_COLLECTION` in ' +
      'src/migrations/runner.ts): a single document `_id: "global"` carrying a ' +
      '`leaseUntil`, which stops two ECS tasks running the Mongo migration ' +
      'runner concurrently during a deploy. It is coordination state for a ' +
      'process that has no Postgres equivalent, and its one row is meaningless ' +
      'thirty seconds after it is written.',
  },

  // --- a model deleted long before the Postgres port ------------------------
  {
    collection: 'analytics',
    reason:
      'The `Analytics` model was DELETED in ce333c92 ("Harden performance, ' +
      'privacy, and deployments"). The only surviving reference in the whole ' +
      'repository is src/migrations/0001-repost-to-boost.ts:78, which rewrites ' +
      '`stats.engagement.reposts` → `.boosts` on whatever rows remain — a ' +
      'migration that has already run. There is no model, no reader, no writer ' +
      'and no table. This is the one collection here whose emptiness has NOT ' +
      'been confirmed against production: it is excluded because nothing reads ' +
      'it, and a census should still report its document count so the exclusion ' +
      'is made with the number in view.',
  },
];

/** How the runner classified a live collection. */
export type CollectionClassification =
  | { readonly kind: 'migrated'; readonly plan: CollectionPlan }
  | { readonly kind: 'excluded'; readonly exclusion: ExcludedCollection }
  | { readonly kind: 'unknown' };

const planByCollection = new Map(COLLECTION_PLANS.map((plan) => [plan.collection, plan]));
const exclusionByCollection = new Map(
  NOT_MIGRATED.map((exclusion) => [exclusion.collection, exclusion])
);

/**
 * Classify a live collection name.
 *
 * `unknown` is the answer the runner turns into a hard failure. It is the only
 * thing standing between "a collection nobody remembered" and silent data loss.
 */
export function classifyCollection(collection: string): CollectionClassification {
  const plan = planByCollection.get(collection);
  if (plan) return { kind: 'migrated', plan };
  const exclusion = exclusionByCollection.get(collection);
  if (exclusion) return { kind: 'excluded', exclusion };
  return { kind: 'unknown' };
}

/**
 * Every table declared in the schema barrel.
 *
 * Written as a loop rather than `.filter(…)` on purpose: the barrel also
 * exports value tuples, regexes and helper functions, so `Object.values` infers
 * a wide union and a user-written type predicate over it fails `TS2677` ("a
 * type predicate's type must be assignable to its parameter's type"). Narrowing
 * inside the loop uses drizzle's own `is`, which narrows correctly.
 */
export function allSchemaTables(): PgTable[] {
  const tables: PgTable[] = [];
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) tables.push(value);
  }
  return tables;
}

/**
 * Tables no plan writes to.
 *
 * Empty is the finish line. A table with no source is either a table that
 * should be fed by a plan and is not, or a table that legitimately has no Mongo
 * counterpart — and there is currently no member of the second class, because
 * all 73 tables were derived FROM the 47 collections that feed them.
 */
export function tablesWithoutAPlan(): string[] {
  const covered = new Set<string>();
  for (const plan of COLLECTION_PLANS) {
    for (const table of planTables(plan)) covered.add(tableName(table));
  }
  return allSchemaTables()
    .map((table) => getTableConfig(table).name)
    .filter((name) => !covered.has(name))
    .sort();
}

/** Every collection name this map knows about, mapped or excluded. */
export function knownCollections(): string[] {
  return [...planByCollection.keys(), ...exclusionByCollection.keys()].sort();
}
