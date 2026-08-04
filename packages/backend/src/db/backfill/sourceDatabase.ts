/**
 * Which database is this run allowed to READ from — asserted, not assumed.
 *
 * ## The mirror of `targetDatabase.ts`, and the gap it closes
 *
 * `assertTargetsEmpty` refuses a target that already holds rows, and
 * `assertTargetDatabase` refuses a target whose name the operator did not
 * predict. Nothing did either for the SOURCE. A copy pointed at an empty or
 * wrong Mongo database discovers its collections at zero documents,
 * `reportDiscovery` prints those zeros and blocks nothing, the copy writes
 * nothing, and the run prints `0 row(s) written` and EXITS 0 — which the
 * runbook's success criterion for §3.3 reads as done.
 *
 * ## `--verify-only` cannot be the second opinion, because it shares the premise
 *
 * §3.4c verifies the copy against the same `MONGODB_URI`. A wrong-but-empty
 * source and an empty target AGREE, so verification confirms a faithful copy of
 * the wrong thing. Two checks that share a premise prove one thing, not two —
 * which is why this refusal has to sit BEFORE the read, not after it.
 *
 * ## Why an identity check and not a population floor
 *
 * The error class is "connected to the wrong database", and that has an exact
 * answer rather than a statistical one. A per-collection floor would encode a
 * population claim that rots — a collection can legitimately empty out — and a
 * false positive HERE costs the cutover window, which is the most expensive
 * false positive in this repository. A name either matches or it does not, and
 * it has no opinion about how much data is present, so it has no false-positive
 * mode at all.
 *
 * The one count kept is the COARSEST possible: zero documents across every
 * migrated collection combined. That cannot be a legitimate production source
 * either, so it also cannot cry wolf.
 *
 * ## Read from the DRIVER, never parsed out of the URI
 *
 * `db.databaseName` is what the driver actually connected to. A URI carries the
 * name in more than one place (path, `authSource`, query defaults), so parsing
 * it re-derives — badly — something the connection already knows. The same
 * reasoning as comparing against `current_database()` rather than against
 * `DATABASE_URL`.
 *
 * ## This is deliberately a THIRD guard
 *
 * #115 is "collapse the two target-database guards, after the cutover". This
 * adds a third, on the other end of the copy. Anyone doing #115 should treat it
 * as in scope and decide about it — not discover it by deleting it.
 */

/** Raised when the connected Mongo database is not the one the operator named. */
export class WrongSourceDatabaseError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `Refusing to run: --source-database=${JSON.stringify(expected)} but ` +
        `MONGODB_URI is connected to ${JSON.stringify(actual)}.\n` +
        'One of those two is wrong, and this tool cannot tell which. Fix the ' +
        'flag if you named the wrong source; fix the MONGODB_URI secret on the ' +
        'task definition if you are pointed somewhere unintended. Nothing has ' +
        'been read and nothing has been written.'
    );
    this.name = 'WrongSourceDatabaseError';
  }
}

/** Raised when a run did not say which source it believes it is reading. */
export class MissingSourceDatabaseError extends Error {
  constructor() {
    super(
      'Refusing to run: --source-database=<name> is REQUIRED, on every mode ' +
        'including --audit-only and --verify-only.\n' +
        'The database this reads from is decided entirely by the MONGODB_URI ' +
        'secret. Naming it here is the operator saying where they believe that ' +
        'points, so a stale or wrong-environment URI fails closed instead of ' +
        'copying nothing and reporting success.'
    );
    this.name = 'MissingSourceDatabaseError';
  }
}

/** Raised when every migrated collection is empty. */
export class EmptySourceError extends Error {
  constructor(readonly collections: number) {
    super(
      `Refusing to run: the source database is connected and correctly named, ` +
        `but all ${collections} migrated collection(s) hold ZERO documents ` +
        'between them.\n' +
        'A production source cannot be empty. The name matched, so this is not ' +
        'the wrong database by name — it is the right name on an empty or ' +
        'freshly created one. Nothing has been written.'
    );
    this.name = 'EmptySourceError';
  }
}

/**
 * The declared source name, or refuse.
 *
 * Separated from the comparison for the same reason the target guard is: this
 * one can be answered before any connection exists, so a missing flag fails
 * before the tool spends a connection finding out.
 */
export function assertSourceDeclared(options: {
  readonly sourceDatabase: string | undefined;
}): string {
  const declared = options.sourceDatabase?.trim();
  if (declared === undefined || declared.length === 0) throw new MissingSourceDatabaseError();
  return declared;
}

/**
 * Refuse unless the connected database has the name the operator predicted.
 *
 * @throws {WrongSourceDatabaseError}
 */
export function assertSourceDatabase(actual: string, expected: string): void {
  if (actual !== expected) throw new WrongSourceDatabaseError(expected, actual);
}

/**
 * Refuse when every migrated collection is empty.
 *
 * Takes the counts the discovery pass already read rather than re-counting:
 * a second count would be a second measurement of a moving source, and the one
 * the report printed is the one the operator is looking at.
 *
 * @throws {EmptySourceError}
 */
export function assertSourceNotEmpty(documentCounts: readonly number[]): void {
  const total = documentCounts.reduce((sum, count) => sum + count, 0);
  if (total === 0) throw new EmptySourceError(documentCounts.length);
}
