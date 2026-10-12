/**
 * Mention's retired identity-authority tables are gone from a fully-migrated
 * database (OxyHQ/oxy#1253). Same instrument as `backfillBookkeepingDropped`:
 * a positive control, then the ledger proving 0036 created them and 0057 ran.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from '@oxy.so/db/migrate';
import { readJournal } from '../../db/migrationsFolder';

const DROPPED_TABLES = [
  'federated_identity_claims',
  'federated_identity_links',
  'federated_identity_link_evidence',
] as const;

const CREATE_TAG = '0036_cross_network_identity_equivalence';
const DROP_TAG = '0057_drop_mention_identity_authority';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function relationExists(name: string): Promise<boolean> {
  const rows = await db.execute<{ oid: string | null }>(
    sql`select to_regclass(${name})::text as oid`,
  );
  return [...rows][0]?.oid != null;
}

function journalWhen(tag: string): number {
  const entry = readJournal().find((candidate) => candidate.tag === tag);
  if (!entry) throw new Error(`No journal entry for ${tag}`);
  return entry.when;
}

describe('the Mention identity-authority tables', () => {
  it('can see a table that does exist — the positive control', async () => {
    await expect(relationExists('federated_actors')).resolves.toBe(true);
  });

  it('were created by 0036 and dropped by 0057 on this database', async () => {
    const created = journalWhen(CREATE_TAG);
    const dropped = journalWhen(DROP_TAG);
    expect(created).toBeLessThan(dropped);
    const rows = await db.execute<{ created_at: string }>(sql`
      select created_at::text from ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}
    `);
    const applied = new Set([...rows].map((row) => Number(row.created_at)));
    expect(applied.has(created)).toBe(true);
    expect(applied.has(dropped)).toBe(true);
  });

  it('leaves none of them behind', async () => {
    for (const table of DROPPED_TABLES) {
      await expect(relationExists(table), table).resolves.toBe(false);
    }
  });
});
