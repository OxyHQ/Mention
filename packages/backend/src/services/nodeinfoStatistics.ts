/**
 * Aggregate statistics behind `GET /nodeinfo/2.0` (#1748).
 *
 * ## Definitions (the counting unit is one stored row)
 *
 * - **Local post**: a `posts` row with no `federation_actor_uri` — authored here.
 * - **External post**: a `posts` row WITH `federation_actor_uri` — an ActivityPub
 *   or atproto post this instance stores. `federation_activity_id` is unique, so a
 *   repeated delivery is one row, never two. An external post is never a local one:
 *   the two are a disjoint partition of `posts`, so `combined = local + external`.
 * - **External actors**: `federated_actors` rows. `uri` is unique, so one actor is
 *   one row; an account reachable under two URIs (an alias) is two rows, which is
 *   why this is reported as "known actor records" and not as distinct people.
 * - **Local users**: NOT reported. Oxy owns identity and exposes no aggregate of
 *   registered users scoped to a deployment; `user_settings` rows are created on
 *   first use, `actor_key_pairs` only for accounts that federate. Either would be
 *   an invented figure, so the field is omitted (unknown is not zero) until Oxy
 *   ships an authoritative aggregate.
 *
 * Posts and replies are not split: the standard `localComments` is omitted for the
 * same reason (no index answers it, and a scan is forbidden by #1160/#1165).
 *
 * ## Cost
 *
 * Three statements per refresh, none a scan of `posts`: the planner estimate for
 * `posts` and `federated_actors` (`pg_class.reltuples`), and one index-only count
 * over the partial index `posts_federation_actor_author_idx`. Local posts are the
 * remainder, so they are an ESTIMATE; `exact` says so.
 */
import { count, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';

export interface NodeinfoStatistics {
  /** Epoch ms the figures were measured. */
  measuredAt: number;
  posts: { local: number; external: number; combined: number };
  /** Known remote actor records; see the module comment. */
  externalActors: number;
  /** False: `local` and `combined` derive from the planner's row estimate. */
  exact: boolean;
}

async function estimateRows(table: string): Promise<number | null> {
  const [row] = await getDb().execute<{ estimate: number }>(
    sql`select reltuples::float8 as estimate from pg_class where oid = to_regclass(${table})`,
  );
  const value = Number(row?.estimate);
  // -1: never analyzed. Unknown, not zero.
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** An exact count, only ever on a table the planner has no estimate for. */
async function exactRows(table: 'posts' | 'federated_actors'): Promise<number> {
  const [row] = await getDb().execute<{ n: string }>(
    sql`select count(*)::text as n from ${sql.identifier(table)}`,
  );
  return Number(row?.n ?? 0);
}

export async function measureNodeinfoStatistics(now = Date.now()): Promise<NodeinfoStatistics> {
  const [postsEstimate, actorsEstimate] = await Promise.all([
    estimateRows('posts'),
    estimateRows('federated_actors'),
  ]);
  const [externalRow] = await getDb()
    .select({ n: count() })
    .from(posts)
    .where(isNotNull(posts.federationActorUri));
  const external = externalRow?.n ?? 0;

  const exact = postsEstimate === null;
  const combined = Math.max(postsEstimate ?? (await exactRows('posts')), external);
  const externalActors = actorsEstimate ?? (await exactRows('federated_actors'));

  return {
    measuredAt: now,
    posts: { local: combined - external, external, combined },
    externalActors,
    exact,
  };
}

/**
 * The namespaced `metadata` extension: local, external and combined figures in
 * one place so a consumer never has to guess which standard field is which.
 * Local users and comments are absent by design (see the module comment).
 */
export function nodeinfoStatisticsExtension(stats: NodeinfoStatistics) {
  return {
    version: 1,
    measuredAt: new Date(stats.measuredAt).toISOString(),
    exact: stats.exact,
    posts: stats.posts,
    externalActors: stats.externalActors,
    scope: 'content and actors known to this instance; not the wider fediverse',
  };
}
