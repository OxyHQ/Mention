/**
 * The posts search is planned per search word, never from a generic plan.
 *
 * ## The regression this pins (issue #1140)
 *
 * postgres.js prepares every statement. After five executions on a connection
 * Postgres may replace a prepared statement's plan with a GENERIC one, built
 * without the parameter — and for the posts search the generic plan walks every
 * post newest-first checking its text. For a rare word that reads most of the
 * table: 6.9ms became 1812ms on 1M seeded posts, and production `/search` ran
 * 3–7s. `applyPostSearchPlanner` forces a custom plan (and a serial one); see
 * `services/search/postSearch.ts`.
 *
 * ## How the test reproduces it
 *
 * The statement is the one the service builds (`postTextMatchSql`, the chrono
 * order, the page limit), PREPARED the way the driver prepares it, on a
 * connection already in generic-plan mode, executed past the five-execution
 * threshold, then EXPLAINed for a rare word. Everything runs in one transaction that is rolled back, so the
 * seeded rows and their statistics reach no other suite.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb, type Transaction } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { chronoOrderBy } from '../../mtn/feed/CursorBuilder';
import { applyPostSearchPlanner, postTextMatchSql } from '../../services/search/postSearch';

/** Posts seeded; the rare word sits only in the OLDEST few, the worst case for a newest-first walk. */
const SEEDED_POSTS = 20_000;
const RARE_WORD = 'zqplanrareword';
const PREPARED = 'post_search_plan_probe';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

interface PlanOutcome {
  plan: string;
  genericPlans: number;
}

/**
 * Seed, prepare, execute past the generic-plan threshold, explain; roll back.
 * `withPlanner` decides whether the service's settings are applied first.
 */
async function planAfterRepeatedExecutions(withPlanner: boolean): Promise<PlanOutcome> {
  const rollback = new Error('roll back the plan fixture');
  let outcome: PlanOutcome = { plan: '', genericPlans: -1 };

  await getDb().transaction(async (tx: Transaction) => {
    await tx.execute(sql`
      insert into posts (id, oxy_user_id, visibility, status, created_at)
      select 'post-search-plan-' || g, 'post-search-plan-author', 'public', 'published',
             date_trunc('milliseconds', now() - g * interval '1 minute')
      from generate_series(1, ${SEEDED_POSTS}) g
    `);
    await tx.execute(sql`
      insert into post_content_variants (id, post_id, position, source, body)
      select 'post-search-plan-v' || g, 'post-search-plan-' || g, 0, 'author',
             'common chatter about everyday things number ' || (g % 97)
               || case when g > ${SEEDED_POSTS - 3} then ${` ${RARE_WORD}`} else '' end
      from generate_series(1, ${SEEDED_POSTS}) g
    `);
    await tx.execute(sql`analyze posts`);
    await tx.execute(sql`analyze post_content_variants`);

    // The worst case, made deterministic: a connection whose cached plan has
    // already gone generic. Whether Postgres's own heuristic flips it after
    // five executions depends on table size and the words searched (it did on
    // 1M seeded posts, it does not on this fixture), so the test does not wait
    // for the heuristic — it starts from its outcome, which the service's
    // settings must override.
    await tx.execute(sql`set local plan_cache_mode = force_generic_plan`);
    if (withPlanner) await applyPostSearchPlanner(tx);

    // The service's own predicate and order; the word is a bind parameter, as
    // it is in production.
    const { sql: text, params } = tx
      .select({ id: posts.id })
      .from(posts)
      .where(and(
        eq(posts.visibility, 'public'),
        eq(posts.status, 'published'),
        postTextMatchSql('placeholder'),
      ))
      .orderBy(...chronoOrderBy())
      .limit(21)
      .toSQL();
    const wordIndex = params.indexOf('placeholder');
    const literal = (value: unknown): string =>
      typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
    const argsFor = (word: string): string =>
      params.map((value, index) => literal(index === wordIndex ? word : value)).join(', ');

    await tx.execute(sql.raw(`prepare ${PREPARED} as ${text}`));
    try {
      // Past the five custom plans after which Postgres considers a generic one,
      // with the mix a live connection sees: common words and rare ones.
      for (const word of ['common', RARE_WORD, 'chatter', RARE_WORD, 'everyday', RARE_WORD]) {
        await tx.execute(sql.raw(`execute ${PREPARED}(${argsFor(word)})`));
      }
      const rows = await tx.execute<Record<string, string>>(
        sql.raw(`explain execute ${PREPARED}(${argsFor(RARE_WORD)})`),
      );
      const [{ generic_plans: genericPlans }] = await tx.execute<{ generic_plans: number }>(
        sql`select generic_plans::int from pg_prepared_statements where name = ${PREPARED}`,
      );
      outcome = { plan: rows.map((row) => Object.values(row)[0]).join('\n'), genericPlans };
    } finally {
      // Session-scoped, so a rollback does not remove it; the pooled connection
      // must not carry it into another suite.
      await tx.execute(sql.raw(`deallocate ${PREPARED}`));
    }
    throw rollback;
  }).catch((error: unknown) => {
    if (error !== rollback) throw error;
  });

  return outcome;
}

describe('posts search planning', () => {
  it('finds a rare word through the text index even after the statement is reused', async () => {
    const { plan, genericPlans } = await planAfterRepeatedExecutions(true);

    expect(genericPlans).toBe(0);
    // Driven from the text match: the matching renditions first, then their
    // posts by primary key. (Through the GIN index or a scan of the renditions
    // is the planner's call at this table size; either is proportional to the
    // matches, not to the table.)
    expect(plan).toMatch(/Filter: \(search_vector @@|Index Cond: \(search_vector @@/);
    expect(plan).toContain('Index Scan using posts_pkey on posts');
    expect(plan).not.toMatch(/Index (Only )?Scan using \w*(chrono|created_at)\w* on posts/);
  }, 60_000);

  it('would otherwise run the cached generic plan (the control)', async () => {
    // Without the settings, the same statement runs on the generic plan —
    // which is what makes `genericPlans` 0 above a property of the settings
    // rather than of the fixture. What the generic plan then does is the
    // planner's call and varies with the fixture's statistics; on 1M posts it
    // was the newest-first walk every time (see the file comment).
    const { genericPlans } = await planAfterRepeatedExecutions(false);

    expect(genericPlans).toBeGreaterThan(0);
  }, 60_000);
});
