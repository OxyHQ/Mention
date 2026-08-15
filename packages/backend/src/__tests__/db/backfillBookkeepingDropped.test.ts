/**
 * The Mongo copier's two bookkeeping tables are gone from a fully-migrated
 * database.
 *
 * `0016_backfill_bookkeeping_tables` created `mention_backfill_checkpoints` and
 * `mention_backfill_resolution_log`; the copier that wrote them was deleted with
 * the rest of Mongo, and `0024_drop_backfill_bookkeeping_tables` removes them.
 * Migrations are immutable history, so 0016 still runs on every database — which
 * is precisely why the drop needs asserting rather than assuming: the test
 * database this file queries CREATED both tables minutes ago and then dropped
 * them, and only the second half is a claim about the change.
 *
 * ## Absence is the answer a broken check gives too
 *
 * "`to_regclass` returned null" is what a dropped table, a misspelt name, a
 * wrong search path and a connection to the wrong database all look like. Three
 * things separate them here, and none is decoration:
 *
 *   1. a POSITIVE CONTROL in the same currency — the identical query against
 *      `posts`, which must resolve. A search path or a database that cannot see
 *      `mention_backfill_checkpoints` cannot see `posts` either;
 *   2. the LEDGER, asserting this database applied 0016 AND 0024. Without it,
 *      absence is equally consistent with a database where the tables were never
 *      created at all, and the test would pass just as happily against a journal
 *      from which 0016 had been deleted — the edit the migration contract forbids;
 *   3. the JOURNAL ORDER, so the pair reads as create-then-drop rather than two
 *      unrelated facts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import {
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  readJournal,
  type JournalEntry,
} from '../../db/migrationLedger';

/** The tables `0016` created and `0024` removes. */
const DROPPED_TABLES = [
  'mention_backfill_checkpoints',
  'mention_backfill_resolution_log',
] as const;

/** The migration that created them, and the one that drops them. */
const CREATE_TAG = '0016_backfill_bookkeeping_tables';
const DROP_TAG = '0024_drop_backfill_bookkeeping_tables';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/**
 * Whether `name` resolves to a relation on this connection's search path.
 *
 * `to_regclass` rather than a `pg_class` predicate on purpose: it answers with
 * the SAME name resolution an ordinary query would use, so a table that exists
 * in a schema this connection cannot reach reads as absent — which is the honest
 * answer to "can anything still use this table".
 */
async function relationExists(name: string): Promise<boolean> {
  const rows = await db.execute<{ oid: string | null }>(
    sql`select to_regclass(${name})::text as oid`
  );
  return [...rows][0]?.oid != null;
}

/** The `when` recorded in the shipped journal for `tag`. */
function journalEntry(tag: string): JournalEntry {
  const entry = readJournal().find((candidate) => candidate.tag === tag);
  if (!entry) throw new Error(`No journal entry for ${tag} — the migration was renamed or removed.`);
  return entry;
}

describe('the backfill bookkeeping tables', () => {
  it('can see a table that DOES exist — the positive control', async () => {
    // Every assertion below reads a null out of `to_regclass`, and a query that
    // cannot resolve any name at all returns null for every one of them. This is
    // what says the instrument works before its readings are believed.
    await expect(relationExists('posts')).resolves.toBe(true);
    await expect(relationExists('post_authorships')).resolves.toBe(true);
  });

  it('reports a name that never existed as absent — the negative control', async () => {
    // The other end of the same instrument: `to_regclass` must actually be
    // capable of answering "no", or the control above is the only reading it can
    // ever produce.
    await expect(relationExists('mention_backfill_no_such_table')).resolves.toBe(false);
  });

  it('was created by 0016 and dropped by 0024 on THIS database', async () => {
    /**
     * The half that makes absence mean "dropped" instead of "never created".
     * Both `when` values must be present in the ledger of the database being
     * queried; the harness applies the whole journal to a throwaway database, so
     * a missing row here means the journal was edited rather than appended to.
     */
    const created = journalEntry(CREATE_TAG);
    const dropped = journalEntry(DROP_TAG);
    expect(created.when).toBeLessThan(dropped.when);

    const rows = await db.execute<{ created_at: string }>(sql`
      select created_at::text from ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}
    `);
    const applied = new Set([...rows].map((row) => Number(row.created_at)));
    expect(applied.size).toBeGreaterThanOrEqual(readJournal().length);
    expect(applied.has(created.when)).toBe(true);
    expect(applied.has(dropped.when)).toBe(true);
  });

  it('leaves neither table behind', async () => {
    for (const table of DROPPED_TABLES) {
      await expect(relationExists(table), table).resolves.toBe(false);
    }
  });
});
