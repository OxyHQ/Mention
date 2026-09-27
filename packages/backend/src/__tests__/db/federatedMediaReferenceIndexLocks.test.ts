import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../db/testDatabase';

/**
 * What `0055_federated_media_reference_indexes.sql` LOCKS — measured, not read
 * off the SQL. The migrator runs every pending file in ONE transaction, so a
 * lock is held until the whole run commits. This replays the real file on a
 * PRIVATE database (reverting its indexes first), reads `pg_locks` for that
 * transaction and rolls back: the two tables get SHARE (reads continue) and
 * nothing stronger; no other table is locked above a read-compatible mode.
 */

const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../../drizzle/0055_federated_media_reference_indexes.sql'),
  'utf8',
);

const REVERT_0055 = [
  'drop index post_variant_media_media_id_idx',
  'drop index user_settings_profile_header_image_idx',
];

/** Lock modes weaker than SHARE: none of them blocks a reader. */
const READ_COMPATIBLE = new Set(['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareRowExclusiveLock']);

let url: string;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  url = await createTestDatabase();
  process.env.DATABASE_URL = previousDatabaseUrl;
}, 120_000);

afterAll(async () => {
  const admin = postgres(process.env.TEST_DATABASE_URL ?? previousDatabaseUrl ?? '', { max: 1 });
  const name = new URL(url).pathname.replace(/^\//, '');
  await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => undefined);
  await admin.end();
}, 60_000);

describe('0055 lock profile', () => {
  it('takes SHARE (reads continue) on the two indexed tables and nothing read-blocking elsewhere', async () => {
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await sql.begin(async (tx) => {
        for (const statement of REVERT_0055) await tx.unsafe(statement);
      });
      const measured = await sql.begin(async (tx) => {
        for (const statement of MIGRATION.split('--> statement-breakpoint')) {
          if (statement.trim()) await tx.unsafe(statement);
        }
        const locks = await tx<{ relname: string; mode: string; relkind: string }[]>`
          select c.relname, l.mode, c.relkind::text as relkind
          from pg_locks l join pg_class c on c.oid = l.relation
          where l.pid = pg_backend_pid() and l.granted and c.relkind in ('r', 'p')
            and c.relnamespace = 'public'::regnamespace
        `;
        const indexes = await tx<{ indexname: string }[]>`
          select indexname from pg_indexes
          where indexname in ('post_variant_media_media_id_idx', 'user_settings_profile_header_image_idx')
        `;
        const timeouts = await tx<{ lock: string; statement: string }[]>`
          select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement
        `;
        throw Object.assign(new Error('rollback'), { measured: { locks: [...locks], indexes: [...indexes], timeouts: timeouts[0] } });
      }).catch((err: { measured?: unknown }) => {
        if (!err.measured) throw err;
        return err.measured as {
          locks: { relname: string; mode: string }[];
          indexes: { indexname: string }[];
          timeouts: { lock: string; statement: string };
        };
      });

      expect(measured.indexes.map((row) => row.indexname).sort())
        .toEqual(['post_variant_media_media_id_idx', 'user_settings_profile_header_image_idx']);
      for (const table of ['post_variant_media', 'user_settings']) {
        const modes = measured.locks.filter((lock) => lock.relname === table).map((lock) => lock.mode);
        expect(modes).toContain('ShareLock');
        expect(modes.filter((mode) => mode !== 'ShareLock' && !READ_COMPATIBLE.has(mode))).toEqual([]);
      }
      const others = measured.locks.filter((lock) => !['post_variant_media', 'user_settings'].includes(lock.relname));
      expect(others.filter((lock) => !READ_COMPATIBLE.has(lock.mode))).toEqual([]);
      // The bounded timeouts are restored for any later migration in the run.
      expect(measured.timeouts).not.toEqual({ lock: '5s', statement: '1min' });
    } finally {
      await sql.end();
    }
  }, 60_000);

  it('is a no-op for indexes an operator already built CONCURRENTLY', async () => {
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await sql.begin(async (tx) => {
        for (const statement of MIGRATION.split('--> statement-breakpoint')) {
          if (statement.trim()) await tx.unsafe(statement);
        }
      });
    } finally {
      await sql.end();
    }
  }, 60_000);
});
