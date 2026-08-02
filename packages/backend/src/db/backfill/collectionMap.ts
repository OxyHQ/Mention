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
 * ## Models are NOT all under `src/models/` — do not assume they are
 *
 * This map was first built by an extractor that walked `src/models/` and read
 * `Model.collection.collectionName` off the mongoose registry. That is the
 * right technique and it was correctly implemented; its blind spot was a
 * DIRECTORY ASSUMPTION. The MCP models live in `src/mcp/models/`
 * (`McpConnection`, `McpRegisteredClient`, `McpAuthCode`) and were therefore
 * invisible to it — not deleted, not legacy, just one directory over.
 *
 * The lesson is the general one, and it is why this paragraph exists rather
 * than three extra entries: a code-derived map is only ever as complete as the
 * paths it walks, so it needs a live `db.listCollections()` census BESIDE it.
 * Any future extractor must scan for `mongoose.model(` across the whole
 * package, not a directory someone remembers.
 *
 * ## A low document count is not a low stake
 *
 * `mcpconnections` holds 13 documents. It is also the bundle graph every linked
 * Claude account resolves through (`src/mcp/middleware/mcpAuth.ts`), so losing
 * those thirteen rows signs every MCP user out with no way back. Nothing in
 * this file may be prioritised, or excluded, by row count.
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
import { DISCOVERY_PLANS } from './plans/discovery';
import { ENGAGEMENT_PLANS } from './plans/engagement';

/**
 * Every collection that moves, and what it becomes.
 *
 * EMPTY pending TEN collections that hold real production data and have no
 * table in this schema. Every one is a decision someone has to make, not work
 * anyone can just do — a plan cannot name a table that does not exist.
 *
 * Counts are from a read-only census of `mention-production` on 2026-08-02
 * (`listCollections` + `countDocuments`, zero writes).
 *
 * **Group 1 — landed on `main` after this branch point** (`f4386de5`).
 * `drizzle/foundation` cut before them, so they have models and writers on
 * `main` and no table here:
 *
 * | collection | documents |
 * |---|---|
 * | `blocklistproposals` | 751 |
 * | `blockeddomainpurges` | 118 |
 * | `blockeddomainpurgeruns` | 35 |
 * | `adminscriptcursors` | 4 |
 * | `repairfetchfailures` | 0 |
 * | `trendsummaries` | 0 |
 * | `blocklistproposalruns` | 0 |
 *
 * These are emphatically NOT exclusions: 751 blocklist proposals and 118
 * blocked-domain purge records are hand-made moderation decisions, and a zero
 * today is not a zero at cutover — `repairfetchfailures` fills the moment the
 * repair sweep next fails.
 *
 * **Group 2 — the MCP surface, which this map originally MISSED.** Its models
 * live in `src/mcp/models/`, not `src/models/`, so an inventory that walked
 * only the latter never saw them. They are live, not deleted:
 *
 * | collection | model | documents |
 * |---|---|---|
 * | `mcpconnections` | `McpConnection` (470296b7) | 13 |
 * | `mcpregisteredclients` | `McpRegisteredClient` (07bcdb85) | 8 |
 * | `mcpauthcodes` | `McpAuthCode` (470296b7) | 0 |
 *
 * `mcpconnections` carries the bundle graph every linked Claude account
 * resolves through (`packages/backend/src/mcp/middleware/mcpAuth.ts`); losing
 * it signs every MCP user out with no way back. `mcpregisteredclients` is the
 * DCR registry. `mcpauthcodes` is single-use and short-lived, so it is the one
 * of the three that could defensibly be excluded — but that is still a
 * decision, and it needs writing down either way.
 *
 * Writing plans before these have tables would mean guessing, and a plan that
 * is wrong about which table a collection feeds is worse than a missing one:
 * the missing one fails loudly at `discover()`.
 */
export const COLLECTION_PLANS: readonly CollectionPlan[] = [
  ...ENGAGEMENT_PLANS,
  ...DISCOVERY_PLANS,
];

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

  // --- models deleted by the ce333c92 privacy/performance cleanup ----------
  {
    collection: 'analytics',
    reason:
      'The `Analytics` model was DELETED in ce333c92 ("Harden performance, ' +
      'privacy, and deployments"). The only surviving reference in the whole ' +
      'repository is src/migrations/0001-repost-to-boost.ts:78, which rewrites ' +
      '`stats.engagement.reposts` → `.boosts` on whatever rows remain — a ' +
      'migration that has already run. No model, no reader, no writer, no ' +
      'table. MEASURED EMPTY: 0 documents in mention-production, 2026-08-02.',
  },
  {
    collection: 'blocks',
    reason:
      'The `Block` model was deleted by the same ce333c92 cleanup. Blocking is ' +
      "Oxy's — Mention reads the block graph through the SDK and stores no " +
      'copy of it, which is why there is no `blocks` table and why the feed ' +
      "safety modules never query one. 0 documents, 2026-08-02; the graph's " +
      'real home is unaffected by this migration.',
  },
  {
    collection: 'restricts',
    reason:
      'The `Restrict` model, deleted alongside `Block` in ce333c92, for the ' +
      'same reason: restriction is an Oxy privacy setting, not Mention state. ' +
      '0 documents, 2026-08-02.',
  },

  // --- superseded aggregates ------------------------------------------------
  {
    collection: 'hashtags',
    reason:
      'The `Hashtag` model was DELETED in f399537c ("Complete performance ' +
      'security and legacy cleanup"). It was a denormalized per-tag aggregate; ' +
      'hashtags now live ON the post as `Post.hashtags: string[]` (canonical ' +
      'lowercase, no `#`, deduped — models/Post.ts:53) and reach Postgres as ' +
      '`posts.hashtags`, which IS migrated. Nothing reads the collection: every ' +
      'surviving `Hashtag` reference in the repository is either the ' +
      "ActivityPub `type: 'Hashtag'` tag object or the NSFW constant list, " +
      'neither of which touches Mongo. 1,677 documents, 2026-08-02 — by far the ' +
      'largest exclusion here. The justification is DERIVABLE FROM A MIGRATED ' +
      'COLUMN, which is a stronger claim than "superseded" and licenses more ' +
      'confidence: every row of this aggregate is recomputable from ' +
      '`posts.hashtags`, a column this migration copies, so nothing is lost ' +
      'that cannot be reconstructed from data that moved. An exclusion resting ' +
      'only on "a newer mechanism replaced it" would NOT license that, because ' +
      'the newer mechanism need not carry the same rows.',
  },
  {
    collection: 'externalfeeds',
    reason:
      'The `ExternalFeed` stub was REPLACED by native `FeedGenerator` records ' +
      'in 18e469f5 / 6afc97aa ("sync Bluesky feeds as native FeedGenerators", ' +
      '#456), which deleted the model. Its successor `feedgenerators` → ' +
      '`feed_generators` IS migrated, and the sync repopulates from Bluesky ' +
      'rather than from these rows. 322 documents, 2026-08-02. This is the ' +
      'WEAKER "superseded" justification rather than the derivable-from-a-' +
      'migrated-column one `hashtags` has, so it is worth being precise about ' +
      'what carries it: the successor does not merely exist, it is REPOPULATED ' +
      'from Bluesky by the sync, so the rows are reproducible from the upstream ' +
      'that produced them. A spent source ' +
      'whose data already exists in the collection that replaced it, so ' +
      'copying it would double-migrate.',
  },

  // --- live rooms moved to Syra (530e2b0f, #315) ---------------------------
  {
    collection: 'rooms',
    reason:
      "Live rooms left Mention: 530e2b0f migrated them from Agora to SYRA's " +
      'backend (#315) and deleted the `Room` model. Mention owns the room ' +
      'EXPERIENCE (`LiveRoomContext`, the room UI, `lib/syraApi.ts`) but ' +
      'persists no room document — rooms are served by `@syra.fm/sdk` against ' +
      "SYRA's API, not `api.mention.earth`. 6 documents, 2026-08-02: residue " +
      'of the pre-migration Agora implementation. Copying them into a Mention ' +
      'table would create a second, stale authority for state another service ' +
      'owns.',
  },
  {
    collection: 'recordings',
    reason:
      'Room recordings, deleted with the rest of the Agora implementation in ' +
      '530e2b0f. The `Recording` model was added by a0e8e795 for Agora cloud ' +
      'recording, which Mention no longer performs. 18 documents, 2026-08-02.',
  },
  {
    collection: 'houses',
    reason:
      'The `House` model (a room grouping) was added with Rooms in a6b44e76 ' +
      'and deleted with them in 530e2b0f. 1 document, 2026-08-02.',
  },
  {
    collection: 'series',
    reason:
      'The `Series` model (a recurring-room schedule) was added with Rooms in ' +
      'a6b44e76 and deleted with them in 530e2b0f. 0 documents, 2026-08-02.',
  },
  {
    collection: 'spaces',
    reason:
      'DOUBLY dead: `Space` was renamed to `Room` by f1fcd225 ("complete ' +
      'Spaces-to-Rooms refactoring"), and Rooms then left for Syra in ' +
      '530e2b0f. These 13 documents (2026-08-02) predate a rename that itself ' +
      'predates the feature leaving the product. There has been no `Space` ' +
      'model and no reader for either shape since.',
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
