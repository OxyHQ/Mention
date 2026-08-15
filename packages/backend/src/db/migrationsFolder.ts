/**
 * Mention's own migrations folder, and the two `@oxyhq/db/migrate` entry
 * points that need to know where it is.
 *
 * `readJournal` and `assertPostgresMigrationsCurrent` are pure mechanism in
 * `@oxyhq/db/migrate` — see that module's own doc comments — and take the
 * migrations folder as a required argument on purpose: a shared package ships
 * no migration files of its own, so it has nowhere it could default to that
 * would not risk resolving to the wrong place once installed. WHICH folder a
 * bare call reads is Mention's own default, so it is re-exported here rather
 * than at every call site.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type postgres from 'postgres';
import {
  assertPostgresMigrationsCurrent as assertPostgresMigrationsCurrentAgainst,
  readJournal as readJournalFrom,
  type JournalEntry,
} from '@oxyhq/db/migrate';

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

/** {@link readJournalFrom}, defaulted to {@link MIGRATIONS_FOLDER}. */
export function readJournal(folder: string = MIGRATIONS_FOLDER): JournalEntry[] {
  return readJournalFrom(folder);
}

/** {@link assertPostgresMigrationsCurrentAgainst}, defaulted to this image's own journal. */
export async function assertPostgresMigrationsCurrent(
  client: postgres.Sql,
  entries: JournalEntry[] = readJournal()
): Promise<void> {
  return assertPostgresMigrationsCurrentAgainst(client, entries);
}
