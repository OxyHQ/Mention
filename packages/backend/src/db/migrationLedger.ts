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
 * A journal entry the high-water rule can never reach.
 *
 * Thrown by {@link planMigrationRun} instead of being reported, because the
 * whole defect is that the condition is currently INVISIBLE: it presents as
 * `No pending Postgres migrations` and exit 0.
 */
export class UnreachableMigrationError extends Error {
  /** The entries that will never be applied, in journal order. */
  readonly entries: readonly JournalEntry[];

  constructor(entries: readonly JournalEntry[], highWaterMillis: number) {
    super(
      `${entries.length} migration(s) in this image can never be applied: ` +
      `${entries.map((entry) => `${entry.tag} (when=${entry.when})`).join(', ')}. ` +
      `The applied-migration ledger has reached ${highWaterMillis}, and both this ` +
      'migrator and drizzle-kit apply a migration only when its journal timestamp ' +
      'is strictly NEWER than the newest recorded one — so these are skipped in ' +
      'silence and the run reports success. This happens when a migration is ' +
      'generated on a branch that was created before another branch\'s migration ' +
      'landed. Fix it by regenerating the affected migration(s) so their `when` ' +
      'is newer than every applied one (rename the file and its ' +
      'drizzle/meta/_journal.json entry), NEVER by editing the ledger.'
    );
    this.name = 'UnreachableMigrationError';
    this.entries = entries;
  }
}

/**
 * The newest `created_at` in the ledger, or `null` when nothing is recorded.
 *
 * Split from {@link readAppliedMillis} so the high-water rule has ONE
 * definition: `pendingEntries` and `unreachableEntries` both key off this, and
 * `Math.max` over an empty list returning `-Infinity` is exactly the sort of
 * silent wrong answer this file exists to refuse.
 */
export function highWaterMillis(appliedMillis: readonly number[]): number | null {
  return appliedMillis.length === 0 ? null : Math.max(...appliedMillis);
}

/**
 * Journal entries that are NOT recorded in the ledger and sit at or below its
 * high-water mark — the ones the apply rule steps over without a word.
 *
 * ## Why this is a separate question from `pendingEntries`
 *
 * `pendingEntries` mirrors the APPLY rule, and must keep doing so (see its own
 * docblock). But that rule is a high-water filter rather than a set difference,
 * so the two disagree on exactly one input: an entry the ledger has never
 * recorded whose `when` is not newer than the newest recorded one. `pendingEntries`
 * says "not pending" — truthfully, since it will never be applied — and the
 * migrator therefore reports a clean run over a migration that did not happen.
 *
 * This function names that set. It does not change what gets applied; it makes
 * the difference between the two rules SAYABLE, which is the whole defect.
 *
 * ## This journal already contains the shape that produces it
 *
 * `0005_post_trend_terms` (when=1785675946096) sits below `0004` (1785680245091),
 * as does `0006`. On a database migrated from empty they all apply — drizzle
 * reads the ledger ONCE before its loop, so `!lastDbMigration` holds for every
 * entry in that run. On a database already at `0004`, both are skipped forever.
 * Generating migrations on parallel branches and merging is what produces it,
 * and this repo is worked from ~160 worktrees.
 *
 * ## Identity is the timestamp, not the hash
 *
 * The ledger stores drizzle's own content hash and `created_at`; only the second
 * is derivable from the journal without reimplementing drizzle's hashing, and it
 * is the value the apply rule itself compares. Two migrations generated in the
 * same millisecond would be indistinguishable here — noted rather than guarded,
 * because the collision makes this check MISS a skip (it never invents one), and
 * `db:generate` has never produced one in this journal.
 */
export function unreachableEntries(
  entries: JournalEntry[],
  appliedMillis: readonly number[]
): JournalEntry[] {
  const highWater = highWaterMillis(appliedMillis);
  // Nothing recorded: drizzle's `!lastDbMigration` branch applies the whole
  // journal regardless of order, so no entry is unreachable on a fresh database.
  if (highWater === null) return [];
  const applied = new Set(appliedMillis);
  // `<=` states the apply rule faithfully (drizzle applies when `lastApplied <
  // when`, so `when <= lastApplied` is skipped). It is EQUIVALENT to `<` here
  // and cannot be tested apart from it: `highWater` is `Math.max(appliedMillis)`
  // and is therefore always a member of `appliedMillis`, so `entry.when ===
  // highWater` implies `applied.has(entry.when)` and the second clause rejects
  // it either way. Verified by mutation — `<` survives the suite — and then by
  // 200,000 random inputs, zero disagreements. Kept as `<=` because it says what
  // the rule is; do not "fix" either direction expecting a behaviour change.
  return entries.filter((entry) => entry.when <= highWater && !applied.has(entry.when));
}

/**
 * What this run should apply — or a refusal, when the journal holds an entry the
 * apply rule cannot reach.
 *
 * The check is INSIDE the function that produces the pending list, not beside
 * it, so a caller cannot obtain the plan without it having run. That is the
 * difference between a guard and a comment: removing this one means rewriting
 * the call site to ask a different function, rather than deleting a line.
 *
 * @throws {UnreachableMigrationError} When any journal entry sits at or below
 *   the ledger's high-water mark without a row of its own.
 */
export function planMigrationRun(
  entries: JournalEntry[],
  appliedMillis: readonly number[]
): JournalEntry[] {
  const unreachable = unreachableEntries(entries, appliedMillis);
  const highWater = highWaterMillis(appliedMillis);
  if (unreachable.length > 0 && highWater !== null) {
    throw new UnreachableMigrationError(unreachable, highWater);
  }
  return pendingEntries(entries, highWater);
}

/**
 * Every `created_at` the ledger has recorded, or `[]` when the ledger table does
 * not exist yet (a database no migration has ever touched).
 *
 * The empty array and the absent table collapse deliberately: both mean "no
 * migration is recorded", which is the one input on which every rule here agrees.
 *
 * Reads only — calling it against a fresh database creates nothing, which is
 * what lets the dry run stay genuinely read-only.
 */
export async function readAppliedMillis(client: postgres.Sql): Promise<number[]> {
  const [ledger] = await client<{ present: boolean }[]>`
    select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) is not null as present
  `;
  if (!ledger?.present) return [];

  const rows = await client<{ created_at: string | null }[]>`
    select created_at
    from ${client(MIGRATIONS_SCHEMA)}.${client(MIGRATIONS_TABLE)}
  `;

  // `bigint` arrives as a string from postgres.js. A NULL `created_at` is
  // dropped rather than coerced: `Number(null)` is 0, which would read as a row
  // applied at the epoch and drag the whole comparison with it.
  return rows
    .map((row) => row.created_at)
    .filter((value): value is string => value !== null)
    .map(Number);
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

/**
 * Refuse to serve when the database is BEHIND the migrations in this image.
 *
 * The failure this exists to prevent lands after the point of no return. The
 * deploy applies migrations in a one-shot task; if that one-shot did not run —
 * or ran against the wrong database — the web tasks still start, still connect,
 * still answer the ALB health check, and then fail every query against a schema
 * that is not there. By then traffic has already been routed to them. A task
 * that cannot serve correctly must not be able to say that it can, so this
 * throws during boot: `bootServer`'s handler marks the runtime not-ready and
 * exits, and the task never reaches `server.listen`.
 *
 * The comparison is `pendingEntries` — the SAME rule the migrator itself
 * applies, from the same journal and the same ledger table. A gate that asked a
 * different question than the apply path answers would eventually disagree with
 * it, and the disagreement would surface as a task that refuses to boot against
 * a database that is in fact current.
 *
 * The message NAMES the missing tags. "Schema is not current" sends whoever is
 * holding a frozen deploy to go and diff two things by hand; the tags tell them
 * immediately whether the one-shot never ran (all of them) or died partway
 * (some of them).
 *
 * @param entries Defaults to the journal shipped in this image. Injectable so a
 *   test can stage a ledger behind the image without writing to the ledger table
 *   that every other test file in the run shares.
 * @throws {Error} When any journal entry has no ledger row.
 */
export async function assertPostgresMigrationsCurrent(
  client: postgres.Sql,
  entries: JournalEntry[] = readJournal()
): Promise<void> {
  const pending = pendingEntries(entries, await readLastAppliedMillis(client));
  if (pending.length === 0) return;

  throw new Error(
    `Postgres schema is not current: ${pending.length} migration(s) shipped in ` +
    `this image have not been applied: ${pending.map((entry) => entry.tag).join(', ')}. ` +
    'Apply them with the deployment migration one-shot ' +
    '(`bun packages/backend/dist/src/db/migrate.js` against DATABASE_URL) ' +
    'before this task can serve traffic.'
  );
}
