/**
 * Run work against a connection whose statements are bounded by a deadline.
 *
 * ## Why this is the load-bearing half of a "budget"
 *
 * The intuitive way to bound a slow lane is `Promise.race` against a timer. It
 * does not bound anything that matters: the promise is abandoned while Postgres
 * keeps executing the query and keeps holding its pooled connection. Under load
 * a slow lane then exhausts the pool even though every request "returned fast",
 * and the symptom is the whole service stalling rather than one lane being
 * slow — which is strictly harder to diagnose than the problem it was meant to
 * fix.
 *
 * `statement_timeout` is what actually stops the work. A race is still useful
 * for the parts of a lane that are NOT Postgres (an outbound HTTP call to Oxy
 * or Clarity), so a real budget is usually both; this is the half that is easy
 * to leave out.
 *
 * ## Why a transaction
 *
 * `SET LOCAL` is transaction-scoped, which is the point: the setting cannot
 * leak onto a pooled connection and silently bound an unrelated query later.
 * `set_config(..., true)` is the parameterisable spelling — `SET` itself takes
 * no bind parameters, so the milliseconds would otherwise have to be
 * interpolated into SQL.
 *
 * Generalized from `controllers/statistics.controller.ts`'s
 * `withStatisticsTimeout`, which had the pattern right and kept it private.
 * That one ALSO wanted the transaction for snapshot consistency across four
 * queries; this one wants it only for the setting's scope, and says so because
 * the two reasons come apart: a caller here must not assume the transaction is
 * buying it a consistent read of anything it did not put inside.
 */

import { sql } from 'drizzle-orm';

import { getDb } from '../db/postgres';
import type { Transaction } from '../db/postgres';

/**
 * Whether an error is Postgres refusing to keep running past the deadline.
 *
 * SQLSTATE `57014` is `query_canceled`, which `statement_timeout` raises. Bare
 * SQLSTATE and not a message match: the message is localized by server
 * `lc_messages`, so matching on it works on a developer's machine and fails on
 * a server configured in another language.
 *
 * Drizzle wraps the driver error, so the code can be on the error or on its
 * `cause` — both are checked, because which one it is depends on where in the
 * stack the rejection was re-thrown.
 */
export function isStatementTimeout(error: unknown): boolean {
  const code = (value: unknown): unknown =>
    value && typeof value === 'object' ? (value as { code?: unknown }).code : undefined;
  if (code(error) === '57014') return true;
  const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
  return code(cause) === '57014';
}

/**
 * Run `work` in a transaction whose statements are capped at `budgetMs`.
 *
 * Exceeding the cap rejects with a Postgres `57014`; use
 * {@link isStatementTimeout} to tell that apart from a genuine failure, because
 * a caller that renders "this lane timed out" must not render it for a bug.
 */
export async function withStatementTimeout<T>(
  budgetMs: number,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', ${String(budgetMs)}, true)`);
    return work(tx);
  });
}
