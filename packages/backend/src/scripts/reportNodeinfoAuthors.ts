/**
 * Read-only aggregate check behind NodeInfo's local figures (#1748): who writes
 * the posts it calls "local", and how many of them Oxy counts as users.
 *
 * Prints COUNTS only (no id, handle or content) in one READ ONLY transaction:
 * distinct local authors, how concentrated the posts are in the biggest authors,
 * how many `user_settings` rows exist, and Oxy's registered-account total.
 *
 *   ECS one-shot, on the deployed image:
 *   bun packages/backend/dist/src/scripts/reportNodeinfoAuthors.js
 */
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { getRuntimeOxyClient } from '../runtime/oxyClient';

interface AuthorRow extends Record<string, unknown> {
  localAuthors: number;
  localPosts: number;
  top1Posts: number;
  top5Posts: number;
  top25Posts: number;
  authorsWithOnePost: number;
  settingsRows: number;
  localAuthorsWithSettings: number;
}

export async function reportNodeinfoAuthors() {
  const [row] = await getDb().transaction(
    async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '60s'`);
      return tx.execute<AuthorRow>(sql`
        with per_author as (
          select oxy_user_id, count(*)::int as n
          from posts
          where federation_actor_uri is null and visibility = 'public' and status = 'published'
          group by oxy_user_id
        ), ranked as (
          select n, row_number() over (order by n desc) as rank from per_author
        )
        select
          (select count(*)::int from per_author) as "localAuthors",
          (select coalesce(sum(n), 0)::int from per_author) as "localPosts",
          (select coalesce(sum(n), 0)::int from ranked where rank <= 1) as "top1Posts",
          (select coalesce(sum(n), 0)::int from ranked where rank <= 5) as "top5Posts",
          (select coalesce(sum(n), 0)::int from ranked where rank <= 25) as "top25Posts",
          (select count(*)::int from per_author where n = 1) as "authorsWithOnePost",
          (select count(*)::int from user_settings) as "settingsRows",
          (select count(*)::int from per_author a
            where exists (select 1 from user_settings s where s.oxy_user_id = a.oxy_user_id)) as "localAuthorsWithSettings"`);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  let oxyTotal: { total: number; exact: boolean; stale: boolean } | null = null;
  try {
    const snapshot = await getRuntimeOxyClient().applicationAccountTotal();
    oxyTotal = { total: snapshot.total, exact: snapshot.exact, stale: snapshot.stale };
  } catch {
    // Reported as null: Oxy has no snapshot, or is unreachable.
  }
  return { ...row, oxyTotal };
}

async function main() {
  await connectPostgres();
  const report = await reportNodeinfoAuthors();
  console.log(JSON.stringify({ msg: '[reportNodeinfoAuthors] complete', ...report }));
}

if (require.main === module)
  void main()
    .then(async () => {
      await closePostgres();
      process.exit(0);
    })
    .catch(async () => {
      console.error('[reportNodeinfoAuthors] failed; no report was produced');
      await closePostgres().catch(() => undefined);
      process.exit(1);
    });
