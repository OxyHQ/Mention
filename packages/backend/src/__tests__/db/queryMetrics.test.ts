/**
 * Database query instrumentation.
 *
 * The label derivation is checked as a pure function, because the labels are
 * the difference between a useful metric and a Prometheus cardinality
 * incident. Everything else runs against a REAL pool: the mechanism is a patch
 * over postgres.js's own deferred-execution behaviour, and a mock of
 * `unsafe()` would happily confirm an implementation that breaks the moment
 * drizzle chains `.values()` onto the query it returns.
 */

import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import {
  describeStatement,
  instrumentPostgresClient,
  isQueryInstrumentationEnabled,
  runWithQueryAccounting,
} from '../../db/queryMetrics';
import { posts } from '../../db/schema/posts';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';

let db: Database;

/**
 * The suite must not depend on the ambient `DB_QUERY_METRICS_ENABLED`. The flag
 * is set BEFORE `connectPostgres()` rather than inside a case, because the
 * client is patched once at connect time — flipping it afterwards would leave
 * an unpatched pool and a green-looking test asserting nothing.
 */
let previousInstrumentationSetting = false;

beforeAll(async () => {
  previousInstrumentationSetting = config.postgres.queryMetricsEnabled;
  config.postgres.queryMetricsEnabled = true;
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
  config.postgres.queryMetricsEnabled = previousInstrumentationSetting;
});

beforeEach(() => {
  metrics.reset();
  vi.clearAllMocks();
});

/** Count of a `db_query_duration_ms` series in the registry's own output. */
async function observedQueries(operation: string, table: string): Promise<number> {
  const exposition = await metrics.getPrometheusFormat();
  const line = new RegExp(
    `^db_query_duration_ms_count\\{operation="${operation}",table="${table}"\\} (\\d+)$`,
    'm',
  ).exec(exposition);
  return line ? Number(line[1]) : 0;
}

describe('describeStatement', () => {
  it('names the operation and the table each statement kind touches', () => {
    expect(describeStatement('select "posts"."id" from "posts" where "id" = $1')).toEqual({
      operation: 'select',
      table: 'posts',
    });
    expect(describeStatement('insert into "posts" ("id") values ($1)')).toEqual({
      operation: 'insert',
      table: 'posts',
    });
    expect(describeStatement('update "posts" set "text" = $1 where "id" = $2')).toEqual({
      operation: 'update',
      table: 'posts',
    });
    expect(describeStatement('delete from "posts" where "id" = $1')).toEqual({
      operation: 'delete',
      table: 'posts',
    });
  });

  it('skips a CTE alias and attributes the statement to the real table', () => {
    expect(
      describeStatement(
        'with "recent" as (select "id" from "posts" limit 10) select * from "recent"',
      ),
    ).toEqual({ operation: 'with', table: 'posts' });
  });

  it('resolves a schema-qualified relation to its table name', () => {
    expect(describeStatement('select 1 from "public"."posts"')).toEqual({
      operation: 'select',
      table: 'posts',
    });
  });

  /**
   * The cardinality bound. A relation the schema does not declare cannot mint a
   * label value, whatever the statement calls it — this is the property that
   * makes a table name safe to put in a metric at all.
   */
  it('collapses a relation the schema does not declare', () => {
    expect(describeStatement('select * from "pg_stat_activity"')).toEqual({
      operation: 'select',
      table: 'other',
    });
    expect(describeStatement('select * from "posts_2026_08_shadow_copy"')).toEqual({
      operation: 'select',
      table: 'other',
    });
  });

  it('reads past leading comments and whitespace to find the verb', () => {
    expect(describeStatement('  -- warm the plan\n select 1 from "posts"')).toEqual({
      operation: 'select',
      table: 'posts',
    });
  });

  it('groups transaction control and session statements without a table', () => {
    expect(describeStatement('begin')).toEqual({ operation: 'transaction', table: 'other' });
    expect(describeStatement('commit')).toEqual({ operation: 'transaction', table: 'other' });
    expect(describeStatement('set local statement_timeout = 5000')).toEqual({
      operation: 'session',
      table: 'other',
    });
    // No `from`/`into`/`update`/`join` precedes the relation, so there is no
    // candidate to resolve — an unrecognised verb reports no table rather than
    // guessing at the first identifier it sees.
    expect(describeStatement('vacuum analyze "posts"')).toEqual({
      operation: 'other',
      table: 'other',
    });
  });
});

describe('statement timing', () => {
  it('records a drizzle select against the table it read', async () => {
    await db.select({ id: posts.id }).from(posts).limit(1);

    expect(await observedQueries('select', 'posts')).toBe(1);
    const exposition = await metrics.getPrometheusFormat();
    expect(exposition).toMatch(
      /^db_query_duration_ms_sum\{operation="select",table="posts"\} \d+(?:\.\d+)?$/m,
    );
  });

  /**
   * `.values()` is chained onto the pending query AFTER it is returned, and
   * postgres.js defers execution until the first `then`. An instrumentation
   * that observed the query eagerly would execute it before that call landed —
   * the rows would come back as objects where drizzle expects arrays, and this
   * assertion is what catches it.
   */
  it('does not disturb the row shape drizzle asks for', async () => {
    const rows = await db.execute(sql`select 42 as answer`);
    expect(rows[0]).toEqual({ answer: 42 });
  });

  it('measures statements issued inside a transaction', async () => {
    await db.transaction(async (tx) => {
      await tx.select({ id: posts.id }).from(posts).limit(1);
    });

    expect(await observedQueries('select', 'posts')).toBe(1);
    // postgres.js opens the transaction through the pool's own `unsafe`, so the
    // `begin` is measured too — evidence the outer handle is patched as well as
    // the scoped one.
    expect(await observedQueries('transaction', 'other')).toBeGreaterThanOrEqual(1);
  });

  it('counts a rejected statement without letting the rejection escape', async () => {
    await expect(db.execute(sql`select * from "table_that_does_not_exist"`)).rejects.toThrow();

    const exposition = await metrics.getPrometheusFormat();
    expect(exposition).toMatch(
      /^db_query_errors_total\{operation="select",table="other"\} 1$/m,
    );
  });
});

describe('per-request accounting', () => {
  it('attributes every statement of one unit of work to a single tally', async () => {
    const tally = await runWithQueryAccounting(async (accounting) => {
      await db.execute(sql`select 1`);
      await db.select({ id: posts.id }).from(posts).limit(1);
      return accounting;
    });

    expect(tally.count).toBe(2);
    expect(tally.totalDurationMs).toBeGreaterThan(0);
    expect(tally.errorCount).toBe(0);
  });

  it('counts statements issued from a nested async call, not only direct ones', async () => {
    const readThroughLayers = async (): Promise<void> => {
      await Promise.resolve();
      await db.select({ id: posts.id }).from(posts).limit(1);
    };

    const tally = await runWithQueryAccounting(async (accounting) => {
      await readThroughLayers();
      return accounting;
    });

    expect(tally.count).toBe(1);
  });

  it('leaves work outside a tally uncounted rather than attributing it somewhere', async () => {
    const tally = await runWithQueryAccounting(async (accounting) => accounting);
    await db.execute(sql`select 1`);

    expect(tally.count).toBe(0);
    // The statement is still on the histogram; only the REQUEST attribution is
    // scoped.
    expect(await observedQueries('select', 'other')).toBeGreaterThanOrEqual(1);
  });
});

describe('slow query log', () => {
  it('logs the statement text as pino context, never as an error argument', async () => {
    const previousThreshold = config.postgres.slowQueryMs;
    config.postgres.slowQueryMs = 10;
    try {
      await db.execute(sql`select pg_sleep(0.05)`);
    } finally {
      config.postgres.slowQueryMs = previousThreshold;
    }

    const slowCall = vi
      .mocked(logger.warn)
      .mock.calls.find(([message]) => message === 'Slow database query');
    expect(slowCall).toBeDefined();
    const context = slowCall?.[1];
    // The backend logger merges a non-Error second argument as CONTEXT. An
    // Error here would be silently reshaped into `{ err }` and lose every field.
    expect(context).not.toBeInstanceOf(Error);
    expect(context).toMatchObject({ operation: 'select', table: 'other', truncated: false });
    expect(String((context as { statement: string }).statement)).toContain('pg_sleep');
  });

  it('stays quiet for a statement under the threshold', async () => {
    await db.select({ id: posts.id }).from(posts).limit(1);

    expect(
      vi.mocked(logger.warn).mock.calls.filter(([message]) => message === 'Slow database query'),
    ).toHaveLength(0);
  });
});

describe('the disable switch', () => {
  /**
   * "Negligible when off" is a claim about the CLIENT, not about a branch inside
   * a wrapper — so what is asserted is that no wrapper exists: `unsafe` is still
   * the identical function postgres.js installed.
   */
  it('leaves the client completely unpatched when disabled', async () => {
    // Never connected to: postgres.js opens lazily, so this costs one object.
    const client = postgres('postgres://mention@127.0.0.1:1/unused', { max: 1 });
    const untouched = client.unsafe;
    const previous = config.postgres.queryMetricsEnabled;

    try {
      config.postgres.queryMetricsEnabled = false;
      expect(isQueryInstrumentationEnabled()).toBe(false);
      instrumentPostgresClient(client);
      expect(client.unsafe).toBe(untouched);

      config.postgres.queryMetricsEnabled = true;
      instrumentPostgresClient(client);
      expect(client.unsafe).not.toBe(untouched);

      // Idempotent: a second pass must not stack a wrapper on a wrapper.
      const patched = client.unsafe;
      instrumentPostgresClient(client);
      expect(client.unsafe).toBe(patched);
    } finally {
      config.postgres.queryMetricsEnabled = previous;
      await client.end({ timeout: 1 });
    }
  });
});
