/**
 * Refusing a write that was handed the root connection where a TRANSACTION was
 * required.
 *
 * ## What this replaces, and why a type is not enough
 *
 * In Mongo the invariant was enforced by `session.inTransaction()`. The type made
 * the session mandatory; that runtime check made it mandatory that a transaction
 * was actually OPEN — because a required parameter is satisfied by any session,
 * including a bare `startSession()` nobody opened a transaction on, which
 * type-checks perfectly and commits the row on its own.
 *
 * Drizzle has the same hole, and a wider one. `DatabaseOrTransaction` is the
 * parameter type every repository in this codebase takes, and the ROOT `Database`
 * satisfies it — so `enqueueModerationOutboxEvent(input, getDb())` compiles, runs,
 * commits the row alone, and passes any test that only asserts the row exists. It
 * is also the DEFAULT: every other repository here defaults that parameter to
 * `getDb()`, so the mistake is what you get by forgetting an argument.
 *
 * ## The discriminator
 *
 * Measured against the installed drizzle: the root database is a
 * `PostgresJsDatabase` with NO `rollback`, and a transaction handle is a
 * `PostgresJsTransaction` whose `rollback` is a function — for a nested
 * (savepoint) transaction too. `rollback` is the method a transaction has BECAUSE
 * it is one, so this is a property of what the handle can do rather than a name
 * that happens to differ.
 *
 * `instanceof PgTransaction` was the alternative and is worse here: it depends on
 * exactly one copy of drizzle in the tree, which is a property of the installer's
 * hoisting rather than of this code.
 */

import type { DatabaseOrTransaction, Transaction } from '../postgres';

/**
 * Raised when a write that must commit with its domain row is handed the root
 * connection. Never expected at runtime — it exists so the invariant is ENFORCED
 * rather than reviewed.
 */
export class MissingTransactionError extends Error {
  constructor(operation: string) {
    super(
      `Refusing to run '${operation}' outside a transaction: it must commit together `
      + 'with the domain write it belongs to, or a report is answered 201 and never '
      + 'delivered. Pass the handle from `db.transaction(...)`, not `getDb()`.',
    );
    this.name = 'MissingTransactionError';
  }
}

/**
 * Narrow a `DatabaseOrTransaction` to a transaction, or throw.
 *
 * @throws {MissingTransactionError} When handed the root connection.
 */
export function requireTransaction(
  db: DatabaseOrTransaction,
  operation: string,
): Transaction {
  const rollback = (db as { rollback?: unknown }).rollback;
  if (typeof rollback !== 'function') {
    throw new MissingTransactionError(operation);
  }
  return db as Transaction;
}
