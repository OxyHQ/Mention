/**
 * Which database is this migration allowed to write DDL to — asserted, not assumed.
 *
 * ## Why the migration step needs this more than the copy does
 *
 * `backfill/targetDatabase.ts` gives the COPY the same protection, and the copy
 * is the step everyone worries about because it moves five million rows. The
 * migration step is the more dangerous of the two, for one reason: **it fails
 * silently and success-shaped.**
 *
 * Pointed at the wrong database the copy hits a missing table and dies. Pointed
 * at the wrong database the migrator finds an empty journal ledger, applies the
 * whole journal, logs `Applied 19 Postgres migration(s)` and exits 0 — leaving
 * the real database untouched while the operator reads a success line. The next
 * step then copies into a schema that does not exist. There is no error to
 * notice and nothing to roll back, because nothing failed.
 *
 * That is not hypothetical: `oxy-mention-pgaudit` is the right image and the
 * right application pointed at the probe database, and it is one entry away
 * from Mention's own migrator in the same task-definition list.
 *
 * ## Same shape as the copy's guard, deliberately
 *
 * An explicit AFFIRMATIVE (`--target-database=<name>`) checked against
 * `current_database()`, not a denylist. A denylist answers only the mistakes
 * somebody thought of; an affirmative fails closed on a stale probe URL, on
 * another environment, on a database recreated under a different name. The
 * operator states where they believe they are pointing and being wrong is the
 * case this catches. The message names BOTH sides for the same reason it does
 * there — "wrong database" says you are wrong, `expected mention, got
 * mention_audit_probe` says which end to fix.
 *
 * ## Why this lives here and not in `backfill/`
 *
 * `backfill/` is a cutover tool with an end date; the migrator is permanent.
 * A permanent module must not import from a transient one, so the guard the
 * migrator needs lives at the `db/` level. `backfill/targetDatabase.ts` still
 * holds its own copy plus the `--start-from-empty` confirmation the copy needs
 * and the migrator has no concept of; collapsing the two is a follow-up, not a
 * thing to do while another session is editing that directory.
 */

import type { Sql } from 'postgres';

/** Raised when the connected database is not the one the operator named. */
export class WrongMigrationTargetError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `Refusing to migrate: --target-database=${JSON.stringify(expected)} but ` +
        `DATABASE_URL is connected to ${JSON.stringify(actual)}.\n` +
        'One of those two is wrong, and this tool cannot tell which. Fix the ' +
        'flag if you named the wrong target; fix the DATABASE_URL secret on the ' +
        'task definition if you are pointed somewhere unintended. No DDL has ' +
        'been applied and the migration ledger has not been touched.'
    );
    this.name = 'WrongMigrationTargetError';
  }
}

/** Raised when a run did not say where it believes it is pointing. */
export class MissingMigrationTargetError extends Error {
  constructor() {
    super(
      'Refusing to migrate: --target-database=<name> is REQUIRED, including ' +
        'for DRY_RUN. The database this connects to is decided entirely by the ' +
        'DATABASE_URL secret, so a run that does not state its intended target ' +
        'cannot be checked against it — and a migration aimed at the wrong ' +
        'database does not fail, it reports success over an untouched one. ' +
        'Example: `--target-database=mention_audit_probe` for a rehearsal, ' +
        '`--target-database=mention` for the cutover.'
    );
    this.name = 'MissingMigrationTargetError';
  }
}

/**
 * Read `--target-database=<name>` out of an argument list. No connection needed.
 *
 * Split from {@link assertMigrationTarget} so a mistyped flag is caught BEFORE
 * anything opens a socket — and so the refusal can be tested without a database.
 *
 * @throws {MissingMigrationTargetError} When no target was named.
 */
export function readTargetDatabase(argv: readonly string[]): string {
  const prefix = '--target-database=';
  const flag = argv.find((arg) => arg.startsWith(prefix));
  const target = flag?.slice(prefix.length).trim();
  if (target === undefined || target.length === 0) throw new MissingMigrationTargetError();
  return target;
}

/**
 * Check the named target against the database actually connected.
 *
 * MUST be the first statement issued on the connection: everything this
 * protects — `ensureExtensions`, the ledger read, the DDL itself — is a write
 * or a precondition for one, so an assertion placed after any of them is
 * checking a database it has already begun changing.
 *
 * @throws {WrongMigrationTargetError} When they differ.
 */
export async function assertMigrationTarget(client: Sql, expected: string): Promise<void> {
  const rows = await client<{ current_database: string }[]>`select current_database()`;
  const actual = rows[0]?.current_database;
  if (actual !== expected) throw new WrongMigrationTargetError(expected, actual ?? '(unknown)');
}
