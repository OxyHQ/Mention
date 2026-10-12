import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../db/testDatabase';

/**
 * What `0054_instagram_graph_source.sql` LOCKS — measured, not read off the SQL.
 *
 * The migrator runs every pending file in ONE transaction, so every lock a
 * statement takes is held until the whole run commits. An earlier draft added a
 * column and a unique index to `posts` there: ACCESS EXCLUSIVE on `posts` for the
 * full index build, i.e. every read of every post blocked. This replays the real
 * file inside a transaction on a PRIVATE database (so it contends with no other
 * suite), reads `pg_locks` for that transaction, and rolls back:
 *
 *  - `posts` is never locked above SHARE ROW EXCLUSIVE (reads continue);
 *  - the widened CHECKs are added NOT VALID, so no row is scanned under the
 *    ACCESS EXCLUSIVE the catalog changes need on the federation tables.
 */

const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../../drizzle/0054_instagram_graph_source.sql'),
  'utf8',
);

/** Undo 0054 on an already-migrated database, leaving the 0053 shape. */
const REVERT_0054 = [
  'drop table post_source_keys',
  'drop table federated_media_deletions',
  'drop table federated_media_posters',
  'alter table federated_actors drop constraint federated_actors_instagram_graph_last_result_check',
  'alter table federated_actors drop constraint federated_actors_protocol_check',
  'alter table federated_follows drop constraint federated_follows_network_check',
  'alter table federated_actors drop column instagram_graph_synced_at, drop column instagram_graph_sync_started_at, ' +
    'drop column instagram_graph_last_result, drop column instagram_graph_user_id, drop column instagram_graph_history_depth',
  "alter table federated_actors add constraint federated_actors_protocol_check check (protocol in ('activitypub', 'atproto'))",
  "alter table federated_follows add constraint federated_follows_network_check check (network in ('activitypub', 'atproto'))",
];

/** Lock modes weaker than SHARE: none of them blocks a reader or waits on one. */
const READ_COMPATIBLE = new Set([
  'AccessShareLock',
  'RowShareLock',
  'RowExclusiveLock',
  'ShareUpdateExclusiveLock',
  'ShareRowExclusiveLock',
]);

let url: string;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  url = await createTestDatabase();
  // `createTestDatabase` points DATABASE_URL at the new database; this file only
  // needs the URL, so the rest of the worker keeps its own.
  process.env.DATABASE_URL = previousDatabaseUrl;
}, 120_000);

afterAll(async () => {
  const admin = postgres(process.env.TEST_DATABASE_URL ?? previousDatabaseUrl ?? '', { max: 1 });
  const name = new URL(url).pathname.replace(/^\//, '');
  await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => undefined);
  await admin.end();
}, 60_000);

describe('0054 lock profile', () => {
  it('never takes a read-blocking lock on posts, and scans no row under ACCESS EXCLUSIVE', async () => {
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      // The revert COMMITS on its own (the database is private), so the
      // measured transaction holds only the locks the migration itself takes —
      // dropping the table reverted here would otherwise lock `posts` too.
      await sql.begin(async (tx) => {
        for (const statement of REVERT_0054) await tx.unsafe(statement);
      });
      const measured = await sql
        .begin(async (tx) => {
          for (const statement of MIGRATION.split('--> statement-breakpoint')) {
            if (statement.trim()) await tx.unsafe(statement);
          }
          const locks = await tx<{ relname: string; mode: string }[]>`
          select c.relname, l.mode
          from pg_locks l join pg_class c on c.oid = l.relation
          where l.pid = pg_backend_pid() and l.granted
            and c.relname in ('posts', 'federated_actors', 'federated_follows')
        `;
          const checks = await tx<{ conname: string; convalidated: boolean }[]>`
          select conname, convalidated from pg_constraint
          where conname in ('federated_actors_protocol_check', 'federated_follows_network_check',
                            'federated_actors_instagram_graph_last_result_check')
        `;
          throw Object.assign(new Error('rollback'), {
            measured: { locks: [...locks], checks: [...checks] },
          });
        })
        .catch((err: { measured?: unknown }) => {
          if (!err.measured) throw err;
          return err.measured as {
            locks: { relname: string; mode: string }[];
            checks: { conname: string; convalidated: boolean }[];
          };
        });

      const postsLocks = measured.locks
        .filter((lock) => lock.relname === 'posts')
        .map((lock) => lock.mode);
      expect(postsLocks.length).toBeGreaterThan(0);
      expect(postsLocks.filter((mode) => !READ_COMPATIBLE.has(mode))).toEqual([]);

      expect(measured.checks).toHaveLength(3);
      expect(measured.checks.every((check) => check.convalidated === false)).toBe(true);
    } finally {
      await sql.end();
    }
  }, 60_000);
});
