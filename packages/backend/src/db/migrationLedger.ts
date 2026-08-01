/**
 * The migration journal on disk and the applied-migration ledger in the
 * database — the two things `db/migrate.ts` compares to decide what is pending.
 *
 * Split out from the entrypoint so this logic can be tested without importing a
 * module whose top level connects to a database and sets a non-zero exit code.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type postgres from 'postgres';

/**
 * Where the applied-migration ledger lives. These are drizzle's own defaults,
 * restated as constants and passed EXPLICITLY to `migrate()` so the pending
 * report and the apply path can never read different tables.
 */
export const MIGRATIONS_SCHEMA = 'drizzle';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/** How far above this module `drizzle/` may sit before the search gives up. */
const MIGRATIONS_SEARCH_DEPTH = 6;

/**
 * `packages/backend/drizzle`, found by walking UP from this module rather than
 * by a fixed relative path or the working directory.
 *
 * A fixed path cannot be right in both places this file runs from. Under vitest
 * and `bun src/db/migrate.ts` it loads from `<pkg>/src/db`, two levels below the
 * package root; the compiled form loads from `<pkg>/dist/src/db`, because this
 * package's `tsconfig.json` sets `rootDir: "./"` (the entrypoint `server.ts` is
 * at the package root, so `src/` is preserved inside `dist/`). `'..','..'` is
 * therefore correct in source and silently resolves to `<pkg>/dist/drizzle` —
 * which does not exist — in the container.
 *
 * Silently is the operative word: `migrate()` against a missing folder applies
 * NOTHING and reports success, which is exactly the "clean run that migrated
 * nothing" failure `readJournal` exists to refuse. So the search targets the
 * journal itself, and throws naming every directory it looked in when it cannot
 * find one.
 */
function findMigrationsFolder(): string {
  const attempted: string[] = [];
  let directory = __dirname;
  for (let depth = 0; depth < MIGRATIONS_SEARCH_DEPTH; depth += 1) {
    const candidate = join(directory, 'drizzle');
    attempted.push(candidate);
    if (existsSync(join(candidate, 'meta', '_journal.json'))) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    'Cannot locate the drizzle/ migrations directory. Looked in:\n' +
    `${attempted.map((path) => `  ${path}`).join('\n')}\n` +
    'It must ship next to the compiled migrator — see the production stage of ' +
    'packages/backend/Dockerfile.'
  );
}

export const MIGRATIONS_FOLDER = findMigrationsFolder();

/** One `drizzle/meta/_journal.json` entry: a migration file and when it was generated. */
export interface JournalEntry {
  tag: string;
  when: number;
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.tag === 'string' && typeof entry.when === 'number';
}

/**
 * The migration journal, in generation order.
 *
 * @throws {Error} When the journal is missing, unparseable, or holds no entries.
 *   An empty read must never be mistaken for "nothing to do": that is exactly
 *   how an image shipped without `drizzle/` would report a clean no-op run while
 *   applying nothing.
 */
export function readJournal(folder: string = MIGRATIONS_FOLDER): JournalEntry[] {
  const path = join(folder, 'meta', '_journal.json');

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read the migration journal at ${path}: ` +
      `${error instanceof Error ? error.message : String(error)}. ` +
      'The drizzle/ directory must ship next to the compiled migrator — see the ' +
      'production stage of the Dockerfile.'
    );
  }

  const entries =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).entries
      : undefined;

  if (!Array.isArray(entries) || entries.length === 0 || !entries.every(isJournalEntry)) {
    throw new Error(
      `The migration journal at ${path} holds no usable entries. Refusing to ` +
      'report a clean run against a journal that could not be read.'
    );
  }

  return entries;
}

/**
 * Journal entries the ledger has not recorded.
 *
 * Mirrors drizzle's own rule exactly (`drizzle-orm/pg-core/dialect` `migrate`):
 * a migration runs when there is no ledger row at all, or when its journal
 * timestamp is strictly newer than the newest recorded one. Deliberately NOT a
 * per-hash set comparison — that would answer a different question than the
 * apply path does, and a report that disagrees with the action is worse than no
 * report.
 */
export function pendingEntries(
  entries: JournalEntry[],
  lastAppliedMillis: number | null
): JournalEntry[] {
  if (lastAppliedMillis === null) return [...entries];
  return entries.filter((entry) => lastAppliedMillis < entry.when);
}

/**
 * The newest `created_at` in the ledger, or `null` when the ledger table does
 * not exist yet (a database no migration has ever touched).
 *
 * Reads only — calling it against a fresh database creates nothing, which is
 * what lets the dry run stay genuinely read-only.
 */
export async function readLastAppliedMillis(client: postgres.Sql): Promise<number | null> {
  const [ledger] = await client<{ present: boolean }[]>`
    select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) is not null as present
  `;
  if (!ledger?.present) return null;

  const rows = await client<{ created_at: string | null }[]>`
    select created_at
    from ${client(MIGRATIONS_SCHEMA)}.${client(MIGRATIONS_TABLE)}
    order by created_at desc
    limit 1
  `;

  const createdAt = rows[0]?.created_at;
  // `bigint` arrives as a string from postgres.js; an empty ledger table reads
  // as no row at all.
  return createdAt === undefined || createdAt === null ? null : Number(createdAt);
}
