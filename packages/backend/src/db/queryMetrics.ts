/**
 * Database query instrumentation.
 *
 * Answers three questions the backend previously could not answer at all: how
 * long a statement takes, which statement it was, and how many statements one
 * HTTP request issues. The last one is the number the efficiency programme is
 * built around — a route that looks fine at 40 ms of wall clock and turns out
 * to be forty sequential round trips is invisible to
 * `http_request_duration_ms` alone.
 *
 * ## Where it attaches, and why there
 *
 * The pool's own methods are patched IN PLACE, on the object `createDatabase`
 * returned. Wrapping it in a proxy afterwards would not work: drizzle's
 * `PostgresJsSession` captures the client by reference when the handle is
 * built, so a wrapper created after `createDatabase` is a second object nothing
 * queries through. Patching the object drizzle already holds is what makes the
 * instrumentation reach application traffic at all.
 *
 * `unsafe()` is the load-bearing one. Every drizzle statement — a query
 * builder, a relational query, a `db.execute(sql\`…\`)`, all 500-odd raw `sql`
 * sites — is compiled to a parameterised string and issued through
 * `client.unsafe(text, params)` (`drizzle-orm/postgres-js/session.cjs`).
 * `begin` / `savepoint` / `reserve` hand out a FRESH `sql` object per scope, so
 * those are wrapped too and their scoped handle patched before the caller sees
 * it; otherwise every statement inside a transaction would go unmeasured.
 *
 * ## The one shape that is not instrumented
 *
 * A tagged template issued directly on the raw client — `client\`select 1\`` —
 * is not covered, and cannot be: postgres.js builds the callable inside a
 * closure (`function Sql(handler)`), so its CALL behaviour is not a property
 * anything can replace in place. In this codebase that shape has exactly two
 * call sites, both in `db/postgres.ts` and both `select 1` liveness probes,
 * plus the transaction-control statements postgres.js issues for itself
 * (`savepoint` / `commit` / `rollback`). No application query takes that path;
 * `getPostgresClient()` exists for the migration ledger and has no request-path
 * caller by design. Covering it would mean giving up `createDatabase` — and
 * with it the shared `DATABASE_CASING` guarantee — to build the drizzle handle
 * over a proxy instead, which is a real cost for two `select 1`s.
 *
 * ## Cost when disabled
 *
 * `DB_QUERY_METRICS_ENABLED=false` leaves the client completely unpatched and
 * `requestObservability` outside the async context — there is no wrapper, no
 * proxy and no store on any path, so the cost is not "small", it is absent.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
import { config } from '../config';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import * as schema from './schema';

/**
 * How much of a statement reaches the slow-query log.
 *
 * The text carries `$1` placeholders rather than values, so it discloses the
 * shape of a query and never its arguments; truncating is about log volume, not
 * secrecy. Long enough to reach the `where` clause of a realistic feed query.
 */
const MAX_LOGGED_STATEMENT_LENGTH = 600;

/**
 * The operations `db_query_duration_ms` distinguishes. A closed set of eight:
 * anything else — `explain`, `analyze`, `copy`, a `do` block — collapses into
 * `other` rather than minting a label value.
 */
type QueryOperation =
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'with'
  | 'transaction'
  | 'session'
  | 'other';

const OPERATION_BY_KEYWORD = new Map<string, QueryOperation>([
  ['select', 'select'],
  ['insert', 'insert'],
  ['update', 'update'],
  ['delete', 'delete'],
  ['with', 'with'],
  ['begin', 'transaction'],
  ['start', 'transaction'],
  ['commit', 'transaction'],
  ['rollback', 'transaction'],
  ['savepoint', 'transaction'],
  ['release', 'transaction'],
  ['prepare', 'transaction'],
  ['set', 'session'],
  ['show', 'session'],
  ['discard', 'session'],
]);

/** The label for a statement that names no table this schema knows. */
const UNKNOWN_TABLE = 'other';

/**
 * Every table name the drizzle schema declares.
 *
 * This is the cardinality bound, and the reason a table name may be a metric
 * LABEL at all: the set is fixed when this module is compiled, so a statement
 * naming anything else — a CTE alias, a `pg_catalog` relation, a table added by
 * an extension — resolves to `other` instead of creating a series. Deriving it
 * from the schema rather than writing it out means it cannot drift: a new table
 * is measurable the moment it is exported from `db/schema`, and a deleted one
 * stops being a label without anyone remembering to say so.
 */
const KNOWN_TABLE_NAMES: ReadonlySet<string> = (() => {
  const names = new Set<string>();
  for (const exported of Object.values(schema)) {
    if (is(exported, PgTable)) names.add(getTableName(exported));
  }
  return names;
})();

/**
 * Candidate table names, in the order a statement introduces them.
 *
 * `from` / `into` / `update` / `join` are the four keywords that can precede a
 * relation in the SQL drizzle emits. The first candidate that is a real table
 * wins, which is what makes this survive a CTE: in
 * `with recent as (select … from posts) select … from recent`, `recent` is not
 * a known table and is skipped, so the statement is attributed to `posts`.
 */
const RELATION_CANDIDATE =
  /\b(?:from|into|update|join)\s+(?:"?[a-z_][a-z0-9_$]*"?\s*\.\s*)?"?([a-z_][a-z0-9_$]*)"?/gi;

/** Leading SQL comments and whitespace, which sit before the verb. */
const LEADING_NOISE = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/;

export interface QueryDescriptor {
  readonly operation: QueryOperation;
  readonly table: string;
}

/**
 * Reduce a statement to the two bounded labels it is measured under.
 *
 * Exported because it is the part worth testing directly — the labels are the
 * difference between a useful metric and a cardinality incident, and they are
 * decided here rather than by prom-client.
 */
/**
 * Memoised descriptors, keyed by the statement text.
 *
 * The key space is bounded by the number of DISTINCT statements this codebase
 * emits — drizzle compiles one query builder to one string with `$n`
 * placeholders, so a hot route reuses the same key on every request and the
 * scan below runs once per statement SHAPE rather than once per execution.
 * Cleared rather than evicted on overflow: an LRU's bookkeeping would cost more
 * than the scan it saves, and a full cache means the assumption above is wrong
 * and worth rebuilding from scratch.
 */
const descriptorCache = new Map<string, QueryDescriptor>();
const MAX_CACHED_DESCRIPTORS = 2_048;

export function describeStatement(statement: string): QueryDescriptor {
  const cached = descriptorCache.get(statement);
  if (cached) return cached;
  const derived = deriveDescriptor(statement);
  if (descriptorCache.size >= MAX_CACHED_DESCRIPTORS) descriptorCache.clear();
  descriptorCache.set(statement, derived);
  return derived;
}

function deriveDescriptor(statement: string): QueryDescriptor {
  const text = statement.replace(LEADING_NOISE, '');
  const keyword = /^[a-z]+/i.exec(text)?.[0]?.toLowerCase() ?? '';
  const operation = OPERATION_BY_KEYWORD.get(keyword) ?? 'other';

  if (operation === 'transaction' || operation === 'session') {
    return { operation, table: UNKNOWN_TABLE };
  }

  RELATION_CANDIDATE.lastIndex = 0;
  let match = RELATION_CANDIDATE.exec(text);
  while (match) {
    const candidate = match[1]?.toLowerCase();
    if (candidate && KNOWN_TABLE_NAMES.has(candidate)) {
      return { operation, table: candidate };
    }
    match = RELATION_CANDIDATE.exec(text);
  }
  return { operation, table: UNKNOWN_TABLE };
}

/**
 * What one HTTP request cost the database.
 *
 * Mutable and shared by reference with `requestObservability`, which reads it
 * on `finish` — the request's queries have all settled by then, and a value
 * copied out earlier would under-report.
 */
export interface QueryTally {
  count: number;
  totalDurationMs: number;
  slowCount: number;
  errorCount: number;
}

const requestTally = new AsyncLocalStorage<QueryTally>();

/** Whether statements are being timed at all. */
export function isQueryInstrumentationEnabled(): boolean {
  return config.postgres.queryMetricsEnabled;
}

/**
 * Run `handler` in an async context whose database statements are counted
 * against one tally, and hand that tally to it.
 *
 * The tally propagates to everything `handler` awaits, which is what lets a
 * middleware at the top of the stack account for a query issued five service
 * layers down without either of them knowing about the other.
 */
export function runWithQueryAccounting<T>(handler: (tally: QueryTally) => T): T {
  const tally: QueryTally = {
    count: 0,
    totalDurationMs: 0,
    slowCount: 0,
    errorCount: 0,
  };
  return requestTally.run(tally, () => handler(tally));
}

/**
 * Instrumentation must never be able to fail a query, so the observer is
 * wrapped — but a silently swallowed fault would leave the metric quietly
 * empty, which is the failure this whole module exists to prevent. Logged once
 * per process: the fault would recur on every statement.
 */
let instrumentationFaultReported = false;

function reportInstrumentationFault(error: unknown): void {
  if (instrumentationFaultReported) return;
  instrumentationFaultReported = true;
  logger.error('Database query instrumentation failed', error);
}

function recordStatement(statement: string, durationMs: number, failed: boolean): void {
  try {
    const { operation, table } = describeStatement(statement);
    metrics.recordLatency('db_query_duration_ms', durationMs, { operation, table });
    if (failed) {
      metrics.incrementCounter('db_query_errors_total', 1, { operation, table });
    }

    const slow = durationMs >= config.postgres.slowQueryMs;
    const tally = requestTally.getStore();
    if (tally) {
      tally.count += 1;
      tally.totalDurationMs += durationMs;
      if (failed) tally.errorCount += 1;
      if (slow) tally.slowCount += 1;
    }

    if (slow) {
      logger.warn('Slow database query', {
        operation,
        table,
        durationMs: Math.round(durationMs * 100) / 100,
        // The backend logger merges a non-Error second argument as pino
        // CONTEXT — the opposite of the SDK logger's `error(message, error)`.
        // These are context fields, and `warn` takes nothing else.
        statement: statement.slice(0, MAX_LOGGED_STATEMENT_LENGTH),
        truncated: statement.length > MAX_LOGGED_STATEMENT_LENGTH,
      });
    }
  } catch (error) {
    reportInstrumentationFault(error);
  }
}

/**
 * Methods on a postgres.js `Query` that START the round trip. postgres.js
 * defers execution until one of these is called, so this is where the clock
 * begins — and, critically, why the observer cannot simply be attached when the
 * query object is built: attaching `.then` eagerly would EXECUTE the query
 * before drizzle had a chance to call `.values()` on it.
 */
const TRIGGER_METHODS: ReadonlySet<string> = new Set([
  'then',
  'catch',
  'finally',
  'execute',
  'forEach',
]);

/**
 * Methods that configure a `Query` and return it for chaining. They are
 * re-bound so the chain keeps carrying the instrumented object rather than
 * escaping back to the bare one on the first `.values()`.
 *
 * `cursor()` is deliberately absent. It REPLACES the query's `resolve`/`reject`
 * so the promise this module observes never settles, so timing a cursor here
 * would produce nothing and leak a handler per iteration. Nothing in this
 * codebase streams a cursor; a caller that starts to needs its own measurement.
 */
const CHAINABLE_METHODS: ReadonlySet<string> = new Set([
  'simple',
  'describe',
  'raw',
  'values',
  'readable',
  'writable',
  'cancel',
  'handle',
]);

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Wrap a pending postgres.js query so its duration is recorded when it settles,
 * without changing when — or whether — it runs.
 */
function observeQuery(statement: string, pending: unknown): unknown {
  if (!isThenable(pending)) return pending;

  let startedAt: bigint | null = null;
  let observed = false;

  const settle = (failed: boolean): void => {
    if (startedAt === null) return;
    recordStatement(statement, Number(process.hrtime.bigint() - startedAt) / 1_000_000, failed);
  };

  const trigger = (method: unknown, target: object, receiver: unknown, args: unknown[]): unknown => {
    if (typeof method !== 'function') return method;
    if (startedAt === null) startedAt = process.hrtime.bigint();
    const result = Reflect.apply(method, target, args);
    if (!observed) {
      observed = true;
      // Safe to attach only now: the caller has just triggered execution, so an
      // extra `then` cannot bring it forward. Both branches are handled, so this
      // derived promise never rejects.
      void pending.then(
        () => settle(false),
        () => settle(true),
      );
    }
    return result === target ? receiver : result;
  };

  return new Proxy(pending, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, target);
      if (typeof property !== 'string') return value;
      if (TRIGGER_METHODS.has(property)) {
        return (...args: unknown[]) => trigger(value, target, receiver, args);
      }
      if (CHAINABLE_METHODS.has(property)) {
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          return result === target ? receiver : result;
        };
      }
      return value;
    },
  });
}

/** Guards against patching one `sql` object twice — reconnects, nested scopes. */
const instrumented = new WeakSet<object>();

type SqlProperties = Record<string, unknown>;
type SqlMethod = (...args: unknown[]) => unknown;

/**
 * Replace the callback argument of `begin` / `savepoint` / `reserve` with one
 * that instruments the scoped `sql` handle postgres.js builds for it.
 */
function withInstrumentedScope(args: unknown[]): unknown[] {
  const index = args.findIndex((argument) => typeof argument === 'function');
  if (index === -1) return args;
  const scopeHandler = args[index] as SqlMethod;
  const wrapped = [...args];
  wrapped[index] = (scopedSql: unknown, ...rest: unknown[]) => {
    instrumentSqlHandle(scopedSql);
    return scopeHandler(scopedSql, ...rest);
  };
  return wrapped;
}

function instrumentSqlHandle(handle: unknown): void {
  if (typeof handle !== 'function' && (typeof handle !== 'object' || handle === null)) return;
  const sql = handle as SqlProperties;
  if (instrumented.has(sql)) return;
  instrumented.add(sql);

  const originalUnsafe = sql.unsafe;
  if (typeof originalUnsafe === 'function') {
    const unsafe = originalUnsafe as SqlMethod;
    sql.unsafe = (...args: unknown[]) =>
      observeQuery(String(args[0] ?? ''), Reflect.apply(unsafe, sql, args));
  }

  for (const scopeMethod of ['begin', 'savepoint'] as const) {
    const original = sql[scopeMethod];
    if (typeof original !== 'function') continue;
    const scope = original as SqlMethod;
    sql[scopeMethod] = (...args: unknown[]) =>
      Reflect.apply(scope, sql, withInstrumentedScope(args));
  }

  const originalReserve = sql.reserve;
  if (typeof originalReserve === 'function') {
    const reserve = originalReserve as SqlMethod;
    sql.reserve = async (...args: unknown[]) => {
      const reserved = await Reflect.apply(reserve, sql, args);
      instrumentSqlHandle(reserved);
      return reserved;
    };
  }
}

/**
 * Time every statement this pool issues.
 *
 * Mutates the client rather than returning a wrapper — see the module docblock
 * for why that is the only placement that reaches drizzle. Idempotent, and a
 * no-op when `DB_QUERY_METRICS_ENABLED` is false.
 */
export function instrumentPostgresClient(client: postgres.Sql): void {
  if (!isQueryInstrumentationEnabled()) return;
  instrumentSqlHandle(client);
}
