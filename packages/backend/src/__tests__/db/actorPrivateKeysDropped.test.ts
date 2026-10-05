/**
 * `actor_key_pairs.private_key_pem` is gone from a fully-migrated database, and
 * the columns the local-actor marker still needs are not. Same instrument as
 * `identityAuthorityDropped`: a positive control, then the ledger proving 0061
 * ran.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableColumns, sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from '@oxy.so/db/migrate';
import { readJournal } from '../../db/migrationsFolder';
import { actorKeyPairs } from '../../db/schema/federation';

const DROP_TAG = '0061_drop_plaintext_actor_private_keys';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function columnsOf(table: string): Promise<Set<string>> {
  const rows = await db.execute<{ column_name: string }>(sql`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
  `);
  return new Set([...rows].map((row) => row.column_name));
}

describe('actor_key_pairs', () => {
  it('keeps the public key and the local-actor marker — the positive control', async () => {
    const columns = await columnsOf('actor_key_pairs');
    expect(columns.has('oxy_user_id')).toBe(true);
    expect(columns.has('public_key_pem')).toBe(true);
    expect(columns.has('key_id')).toBe(true);
  });

  it('had its private keys dropped by 0061 on this database', async () => {
    const entry = readJournal().find((candidate) => candidate.tag === DROP_TAG);
    expect(entry).toBeDefined();
    const rows = await db.execute<{ created_at: string }>(sql`
      select created_at::text from ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}
    `);
    const applied = new Set([...rows].map((row) => Number(row.created_at)));
    expect(applied.has(entry!.when)).toBe(true);
  });

  it('holds no private key, in the database or in the schema', async () => {
    const columns = await columnsOf('actor_key_pairs');
    expect(columns.has('private_key_pem')).toBe(false);
    expect(Object.keys(getTableColumns(actorKeyPairs))).not.toContain('privateKeyPem');
  });
});
