import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { applyPostSearchPlanner } from '../../services/search/postSearch';
import { normalizeTsQuery } from '../../services/search/normalizeTsQuery';

beforeAll(connectPostgres);
afterAll(closePostgres);

describe('post search boolean normalization', () => {
  it('gives repeated and stem-equivalent terms the single-term planner estimate', async () => {
    await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`create temporary table repeated_search_probe (document tsvector) on commit drop`,
      );
      await tx.execute(sql`insert into repeated_search_probe select to_tsvector('english',
        case when n % 10 = 0 then 'running' else 'other' end)
        from generate_series(1, 10000) n`);
      await tx.execute(sql`analyze repeated_search_probe`);
      const estimates: number[] = [];
      for (const input of ['running', 'running running', 'running runs']) {
        const query = await applyPostSearchPlanner(tx, input);
        const plan = await tx.execute<{ 'QUERY PLAN': Array<{ Plan: { 'Plan Rows': number } }> }>(
          sql`explain (format json) select * from repeated_search_probe where document @@ ${query}`,
        );
        estimates.push(plan[0]['QUERY PLAN'][0].Plan['Plan Rows']);
      }
      expect(estimates).toEqual([1000, 1000, 1000]);
    });
  });

  it('preserves real PostgreSQL matches for phrases, alternatives, negation and punctuation', async () => {
    const searches = [
      'apple apple',
      'running runs',
      'apple OR apple',
      'apple OR banana apple',
      'apple apple OR banana banana',
      'apple -banana -banana',
      '-apple -apple',
      '"apple apple"',
      '"apple the banana" apple',
      '"apple apple" OR apple',
      '"apple banana" "apple banana"',
      'apple OR "banana apple" -orange',
      "o'reilly o'reilly",
      'foo\\bar foo\\bar',
      'the and',
      '',
    ];
    const documents = [
      '',
      'apple',
      'banana',
      'apple banana',
      'banana apple',
      'apple apple',
      'apple the banana',
      'apple orange',
      'running',
      'runs',
      "o'reilly",
      'foo bar',
    ];
    for (const input of searches) {
      const [parsed] = await getDb().execute<{ query: string }>(
        sql`select websearch_to_tsquery('english', ${input})::text as query`,
      );
      const normalized = normalizeTsQuery(parsed.query);
      const [result] = await getDb().execute<{ same: boolean }>(sql`
        select bool_and((to_tsvector('english', body) @@ ${parsed.query}::tsquery)
          = (to_tsvector('english', body) @@ ${normalized}::tsquery)) as same
        from unnest(ARRAY[${sql.join(
          documents.map((body) => sql`${body}`),
          sql`, `,
        )}]::text[]) as body`);
      expect(result.same).toBe(true);
    }
  });
});
