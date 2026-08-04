/**
 * Driver-Error Translation
 *
 * The Mongo port replaces `error.code === 11000` at every call site with a
 * SQLSTATE check, and a SQLSTATE check is easy to get wrong in a way that
 * silently passes: **drizzle wraps the driver failure in its own error**, so
 * `code` and `constraint_name` live on `cause`, not on the error you catch. A
 * predicate that reads `error.code` directly matches NOTHING — and the call
 * sites that use it are all `catch` blocks that then rethrow, so the failure
 * looks like an unrelated 500 rather than a broken guard.
 *
 * Walking the `cause` chain once, here, is what keeps every "the unique index
 * rejected a concurrent duplicate" branch honest. Mention has a lot of them: the
 * MTN chain's `{oxyUserId, seq}` backstop, the starter-pack `source.uri`
 * import race, `federation.activityId` dedup, and the moderation-enforcement
 * idempotency key all rely on catching a duplicate rather than reading first.
 *
 * `constraintName` is what makes a reaction SPECIFIC. `isUniqueViolation(error)`
 * alone cannot tell "this chain seq is taken, re-read the head" from "an
 * unrelated unique index fired", so a handler that maps a duplicate onto a
 * retry must name the constraint it is answering for — otherwise a future index
 * on the same table quietly starts triggering the wrong recovery.
 */

/** Postgres `unique_violation`. */
export const UNIQUE_VIOLATION = '23505';
/** Postgres `foreign_key_violation`. */
export const FOREIGN_KEY_VIOLATION = '23503';
/** Postgres `check_violation`. */
export const CHECK_VIOLATION = '23514';
/** Postgres `generated_always` — an attempt to write a GENERATED column. */
export const GENERATED_ALWAYS = '428C9';
/**
 * Postgres `serialization_failure` and `deadlock_detected` — the two concurrency
 * outcomes a fresh transaction resolves and the same transaction cannot.
 *
 * They are the reason a retry loop must restart the TRANSACTION rather than
 * re-run a statement: both abort the whole transaction, so anything issued after
 * one inside the same block fails with `25P02` instead of the real cause.
 */
export const SERIALIZATION_FAILURE = '40001';
export const DEADLOCK_DETECTED = '40P01';

/**
 * A statement Postgres CANCELLED — `statement_timeout` expiring, or an explicit
 * `pg_cancel_backend`.
 *
 * A capacity answer, not a fault, and the port of Mongo's `MaxTimeMSExpired`
 * (code 50): a caller that distinguished the two there has to keep
 * distinguishing them here, or a query that ran out of time reaches the client
 * as a 500 and hides a real crash behind the same status. Never retryable in
 * place — the budget will not be larger on the second attempt.
 */
export const QUERY_CANCELED = '57014';

/**
 * Depth ceiling on the `cause` walk. A cyclic chain is not something any driver
 * produces, but an unbounded walk turns one into a hang inside a `catch`.
 */
const MAX_CAUSE_DEPTH = 8;

/**
 * Read a string field off the driver error underneath drizzle's wrapper.
 *
 * `cause` is reached through `Reflect.get` rather than `error.cause`: this
 * package targets ES2020, whose `Error` type has no `cause` property, and the
 * point of this module is to survive exactly that kind of mismatch rather than
 * be silenced with a cast.
 *
 * Returns `undefined` when no error in the chain carries the field, so a caller
 * can never mistake "not a driver error" for a particular SQLSTATE.
 */
function driverField(error: unknown, field: string): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < MAX_CAUSE_DEPTH; depth += 1) {
    const value: unknown = Reflect.get(current, field);
    if (typeof value === 'string') {
      return value;
    }
    current = Reflect.get(current, 'cause');
  }
  return undefined;
}

/** The SQLSTATE of a driver error, or `undefined` when it is not one. */
export function sqlStateOf(error: unknown): string | undefined {
  return driverField(error, 'code');
}

/**
 * The name of the constraint a driver error names, or `undefined`.
 *
 * postgres.js exposes it as `constraint_name` (the wire field), not `constraint`.
 */
export function constraintNameOf(error: unknown): string | undefined {
  return driverField(error, 'constraint_name');
}

/**
 * A driver failure reduced to its STRUCTURAL facts, safe to put in a log.
 *
 * The whole error object is not. postgres.js attaches the failing statement AND
 * its bound parameters (`query`, `params`), and Postgres's own `detail` reads
 * `Failing row contains (…)` — so `logger.warn(msg, { error })` publishes every
 * value the statement carried. That is how two administrative sweeps whose
 * entire contract is "never log a post id" came to log post ids and resume
 * cursors: the backend logger redacts a 24-hex ObjectId under any key, but a
 * uuid v7 primary key is not that shape and passes straight through, and the
 * sweeps only ever run as Fargate one-shots whose only output is CloudWatch.
 *
 * SQLSTATE and the constraint name are the two things worth reading when a write
 * is refused, and neither is data.
 */
export function describeDriverError(error: unknown): {
  code?: string;
  constraint?: string;
  kind: string;
} {
  return {
    code: sqlStateOf(error),
    constraint: constraintNameOf(error),
    kind: error instanceof Error ? error.name : typeof error,
  };
}

/** True when `error` is a unique-index violation, optionally on a NAMED index. */
export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  if (sqlStateOf(error) !== UNIQUE_VIOLATION) {
    return false;
  }
  return constraintName === undefined || constraintNameOf(error) === constraintName;
}

/** True when `error` is a foreign-key violation, optionally on a NAMED constraint. */
export function isForeignKeyViolation(error: unknown, constraintName?: string): boolean {
  if (sqlStateOf(error) !== FOREIGN_KEY_VIOLATION) {
    return false;
  }
  return constraintName === undefined || constraintNameOf(error) === constraintName;
}

/** True when `error` is a CHECK-constraint violation, optionally on a NAMED constraint. */
export function isCheckViolation(error: unknown, constraintName?: string): boolean {
  if (sqlStateOf(error) !== CHECK_VIOLATION) {
    return false;
  }
  return constraintName === undefined || constraintNameOf(error) === constraintName;
}
