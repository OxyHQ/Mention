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
