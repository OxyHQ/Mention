/**
 * PostgreSQL Connection
 *
 * Drizzle ORM over postgres.js (`drizzle-orm/postgres-js`). Runtime-agnostic:
 * the same code path serves the ECS image (which runs `bun server.ts`), a
 * developer's `bun --watch`, and the vitest suite (which runs under **node**,
 * see `packages/backend/package.json` `test`). That last one is the reason this
 * is postgres.js and NOT `drizzle-orm/bun-sql`: `bun-sql` reaches for the `Bun`
 * global and hard-fails the moment anything loads it outside Bun, which is
 * exactly what every test run does.
 *
 * Placement note: Mongo's connector lives in `src/utils/database.ts` in this
 * package (the sibling oxy-api port puts its Postgres connector in
 * `src/config/postgres.ts`). Everything Postgres is kept together under
 * `src/db/` here rather than split across two directories.
 *
 * Shape mirrors the Mongo setup: connect once at boot, then read the handle
 * synchronously from anywhere via `getDb()`.
 */

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config';
import { logger } from '../utils/logger';
import { DATABASE_CASING } from './casing';
import * as schema from './schema';

/** Seconds `closePostgres` waits for in-flight queries before forcing the socket shut. */
const CLOSE_TIMEOUT_SECONDS = 5;

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * An open transaction on that pool — the handle `db.transaction(async (tx) => …)`
 * passes its callback.
 *
 * DERIVED from `Database` rather than written out, so it cannot drift from the
 * schema or from drizzle's generics when either changes.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Either handle. A write that must be able to JOIN a caller's transaction takes
 * this: a `Transaction` is not assignable to `Database` (it has no `$client`),
 * so a helper typed only as `Database` silently forces its caller to run OUTSIDE
 * the transaction — which is how a guarded write loses its atomicity with the
 * work it is supposed to be atomic WITH. Mention has three real transactional
 * paths that depend on this (`PostEngagementCommandService`,
 * `MentionRecordStore.append`, `ReportIntakeService.createReport`).
 */
export type DatabaseOrTransaction = Database | Transaction;

let db: Database | null = null;
let client: postgres.Sql | null = null;

/**
 * Open the connection pool. Call once during startup, before serving traffic.
 *
 * Idempotent: a second call returns the existing handle rather than opening a
 * second pool.
 *
 * @throws {Error} When `DATABASE_URL` is unset — a startup misconfiguration;
 *   fail fast and loudly rather than degrade. Callers that must tolerate an
 *   unmigrated deployment check `config.postgres.url` first.
 */
export async function connectPostgres(): Promise<Database> {
  if (db) return db;

  const url = config.postgres.url;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Start a local Postgres with: ' +
      'docker compose -f docker-compose.postgres.yml up -d postgres'
    );
  }

  const maxPoolSize = config.postgres.maxPoolSize;
  const instanceClient = postgres(url, {
    max: maxPoolSize,
    idle_timeout: config.postgres.idleTimeoutSeconds,
    connect_timeout: config.postgres.connectTimeoutSeconds,
    max_lifetime: config.postgres.maxLifetimeSeconds,
    onnotice: (notice) => logger.debug('Postgres notice', { notice: notice.message }),
  });

  // postgres.js connects lazily, so constructing the pool proves nothing. Issue
  // a real round trip here so an unreachable/misconfigured database fails during
  // startup instead of on the first user request — and only publish the handle
  // once that round trip succeeded.
  try {
    await instanceClient`select 1`;
  } catch (error) {
    await instanceClient.end({ timeout: CLOSE_TIMEOUT_SECONDS });
    throw error;
  }

  client = instanceClient;
  // Drizzle applies `casing` at RUNTIME when building SQL; drizzle-kit applies
  // it at GENERATE time when emitting DDL. They must agree or queries reference
  // columns the migrations never created — so both read the SAME constant, and
  // `db/casing.ts` owns it.
  db = drizzle(instanceClient, { schema, casing: DATABASE_CASING });

  logger.info('Connected to PostgreSQL successfully', { maxPoolSize });
  return db;
}

/**
 * The connection opened by `connectPostgres()`.
 *
 * @throws {Error} If called before `connectPostgres()` resolved — a programming
 *   error (a query issued before startup finished), not a runtime condition to
 *   recover from.
 */
export function getDb(): Database {
  if (!db) {
    throw new Error(
      'PostgreSQL is not connected. Call connectPostgres() during startup ' +
      'before issuing queries.'
    );
  }
  return db;
}

/**
 * Whether `connectPostgres()` has published a handle.
 *
 * SYNCHRONOUS and cheap, so a hot synchronous caller can ask "is there a pool at
 * all?" without a round trip. It is deliberately NOT a liveness check: a pool
 * can exist while the server is unreachable. Anything that must know the
 * database ANSWERS — the health endpoint, a startup gate — uses
 * {@link checkPostgresHealth}, which issues a real query.
 */
export function isPostgresConnected(): boolean {
  return db !== null;
}

/**
 * Whether the database answers a trivial query right now.
 *
 * Never throws: an unreachable database is a health-check RESULT, not an error
 * for the caller to handle.
 */
export async function checkPostgresHealth(): Promise<boolean> {
  const instanceClient = client;
  if (!instanceClient) return false;
  try {
    await instanceClient`select 1`;
    return true;
  } catch (error) {
    logger.error('Postgres health check failed', error);
    return false;
  }
}

/** Close the pool (for shutdown hooks). Safe to call when never connected. */
export async function closePostgres(): Promise<void> {
  const instanceClient = client;
  if (!instanceClient) return;
  client = null;
  db = null;
  await instanceClient.end({ timeout: CLOSE_TIMEOUT_SECONDS });
}
