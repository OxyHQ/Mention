/**
 * Which database is this run allowed to write to — asserted, not assumed.
 *
 * ## The step this exists for
 *
 * The copy puts roughly five million rows into whatever `DATABASE_URL` names.
 * Nothing in the tool ever checked WHICH database that was: the secret wired
 * into a task definition was the only thing deciding, and a task definition is
 * edited by a human under time pressure at the one moment nobody wants to be
 * reviewing JSON.
 *
 * The rehearsal scripts had this mechanism the whole time, pointed the other
 * way — each refused to run unless `current_database()` was
 * `mention_audit_probe`. That guard held for every rehearsal precisely because
 * it was a guard and not a habit. The real run needs the same thing pointed at
 * the real database, which means an EXPLICIT AFFIRMATIVE naming the intended
 * target rather than an absence of objection.
 *
 * ## Why an affirmative rather than a denylist
 *
 * A denylist ("refuse `mention` unless …") answers only the mistakes somebody
 * thought of. An affirmative fails closed on all of them: a `DATABASE_URL`
 * pointing at a stale probe, at another environment, at a database that was
 * recreated under a different name — every one of those is a mismatch and every
 * one refuses. The operator has to state where they believe they are pointing,
 * and being wrong is the case this catches.
 *
 * ## Why the message names BOTH sides
 *
 * "Wrong database" tells an operator they are wrong. `expected mention, got
 * mention_audit_probe` tells them which of the two ends is misconfigured, which
 * is the difference between fixing it and re-running it hopefully.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../postgres';

/** Raised when the connected database is not the one the operator named. */
export class WrongTargetDatabaseError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `Refusing to run: --target-database=${JSON.stringify(expected)} but ` +
        `DATABASE_URL is connected to ${JSON.stringify(actual)}.\n` +
        'One of those two is wrong, and this tool cannot tell which. Fix the ' +
        'flag if you named the wrong target; fix the DATABASE_URL secret on the ' +
        'task definition if you are pointed somewhere unintended. Nothing has ' +
        'been read and nothing has been written.'
    );
    this.name = 'WrongTargetDatabaseError';
  }
}

/** Raised when a run did not say where it believes it is pointing. */
export class MissingTargetDatabaseError extends Error {
  constructor() {
    super(
      'Refusing to run: --target-database=<name> is REQUIRED, on every mode ' +
        'including the read-only ones. The database this connects to is decided ' +
        'entirely by the DATABASE_URL secret, so a run that does not state its ' +
        'intended target cannot be checked against it — which is the whole ' +
        'failure this flag exists to make impossible. Example: ' +
        '`--target-database=mention_audit_probe` for a rehearsal, ' +
        '`--target-database=mention` for the cutover.'
    );
    this.name = 'MissingTargetDatabaseError';
  }
}

/**
 * Raised when `--start-from-empty` was not confirmed against the target.
 *
 * Separate from the reset-mode refusal in `reset.ts`, which answers a different
 * question: that one refuses the flag alongside a mode that promises to write
 * nothing, this one refuses it when nobody named what is about to be emptied.
 */
export class UnconfirmedTruncateError extends Error {
  constructor(readonly target: string) {
    super(
      '--start-from-empty TRUNCATES every target table, and requires ' +
        `--confirm-truncate=${target} to say so out loud.\n` +
        'The reason it needs a second flag rather than a prompt: on a FIRST ' +
        'cutover the target is empty, so a stray --start-from-empty destroys ' +
        'nothing and reports success — and the run that inherits the habit is ' +
        'the resumed one, where it destroys everything already copied. The ' +
        'confirmation must repeat the database name so it cannot be carried ' +
        'from one invocation to another by shell history.'
    );
    this.name = 'UnconfirmedTruncateError';
  }
}

/**
 * Check the flags against each other. No database connection needed.
 *
 * Split from {@link assertTargetDatabase} so the argument mistakes are caught
 * BEFORE anything opens a socket — an operator who mistyped a flag should learn
 * it immediately, not after a Mongo handshake.
 *
 * @throws {MissingTargetDatabaseError} When no target was named.
 * @throws {UnconfirmedTruncateError} When `--start-from-empty` is unconfirmed.
 */
export function assertTargetDeclared(options: {
  readonly targetDatabase: string | undefined;
  readonly startFromEmpty: boolean;
  readonly confirmTruncate: string | undefined;
}): string {
  const target = options.targetDatabase?.trim();
  if (target === undefined || target.length === 0) throw new MissingTargetDatabaseError();
  if (options.startFromEmpty && options.confirmTruncate?.trim() !== target) {
    throw new UnconfirmedTruncateError(target);
  }
  return target;
}

/**
 * Check the named target against the database actually connected.
 *
 * @throws {WrongTargetDatabaseError} When they differ.
 */
export async function assertTargetDatabase(db: Database, expected: string): Promise<void> {
  const rows = await db.execute<{ current_database: string }>(sql`select current_database()`);
  const actual = rows[0]?.current_database;
  if (actual !== expected) throw new WrongTargetDatabaseError(expected, actual ?? '(unknown)');
}
