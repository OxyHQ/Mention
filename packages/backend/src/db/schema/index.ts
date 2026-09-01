/**
 * Drizzle Schema Barrel
 *
 * This file is the single entry point `drizzle.config.ts` generates migrations
 * from AND the object `db/postgres.ts` hands to `drizzle()` for the relational
 * query API — a table that is not re-exported here is invisible to both, so it
 * gets neither a migration nor a typed query.
 *
 * Only TABLE modules belong here. `deferredForeignKeys.ts` and
 * `protectedColumns.ts` are schema support, imported directly by the code that
 * needs them; the shared column builders come from `@oxyhq/db`.
 *
 * The conventions every table follows — naming, ids, enums, timestamps, foreign
 * keys, expiry, protected columns — are in `CONVENTIONS.md`. Read it before
 * adding a table.
 */
export * from './adminScripts';
export * from './articles';
export * from './blocklist';
export * from './channels';
export * from './discovery';
export * from './engagement';
export * from './federation';
export * from './feeds';
export * from './gates';
export * from './lists';
export * from './mcp';
export * from './moderation';
export * from './mtn';
export * from './outbox';
export * from './postContent';
export * from './posts';
export * from './polls';
export * from './userProfile';
