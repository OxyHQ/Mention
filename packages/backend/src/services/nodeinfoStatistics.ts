/**
 * Aggregate statistics behind `GET /nodeinfo/2.0` (#1748).
 *
 * ## Definitions (the counting unit is one stored `posts` row)
 *
 * - **Local**: no `federation_actor_uri` — authored here — counted only while
 *   `visibility = 'public'` and `status = 'published'`. Drafts, scheduled,
 *   deleted and non-public rows are never published, even as aggregates.
 * - **External**: WITH `federation_actor_uri` (ActivityPub or atproto). A stored
 *   federated row is already a delivered, public object; `federation_activity_id`
 *   is unique, so a repeated delivery is one row. Bridged or imported rows that
 *   carry an actor URI are external; a local author's own post never has one.
 * - **Comment** = a row with `is_reply`; **post** = a row without it.
 * - Local and external are a disjoint partition, so `combined = local + external`.
 * - **External actors**: `federated_actors` rows (`uri` unique). An alias under a
 *   second URI is a second record, hence "known actor records", not distinct people.
 * - **Local users**: not reported until Oxy ships an authoritative per-deployment
 *   aggregate (OxyHQ/oxy#2076): `user_settings` is created on first use and
 *   `actor_key_pairs` only for federating accounts, so either would be invented.
 *
 * ## Cost
 *
 * No statement scans `posts`: the local counts are one GROUP BY over the tiny
 * partial index `posts_local_public_kind_idx`; the external counts are index-only
 * over `posts_federation_actor_author_idx` and `posts_external_replies_idx`
 * (migration 0104). The actor figure is the planner estimate (exact on a table
 * never analyzed) and is flagged separately.
 */
import { count, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';

interface Split {
  posts: number;
  comments: number;
  total: number;
}

export interface NodeinfoStatistics {
  /** Epoch ms the figures were measured. */
  measuredAt: number;
  local: Split;
  external: Split;
  combined: Split;
  /** Known remote actor records; see the module comment. */
  externalActors: { count: number; exact: boolean };
}

async function estimateRows(table: string): Promise<number | null> {
  const [row] = await getDb().execute<{ estimate: number }>(
    sql`select reltuples::float8 as estimate from pg_class where oid = to_regclass(${table})`,
  );
  const value = Number(row?.estimate);
  // -1: never analyzed. Unknown, not zero.
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

async function countExternalActors(): Promise<{ count: number; exact: boolean }> {
  const estimate = await estimateRows('federated_actors');
  if (estimate !== null) return { count: estimate, exact: false };
  const [row] = await getDb().execute<{ n: string }>(
    sql`select count(*)::text as n from federated_actors`,
  );
  return { count: Number(row?.n ?? 0), exact: true };
}

const split = (postCount: number, commentCount: number): Split => ({
  posts: postCount,
  comments: commentCount,
  total: postCount + commentCount,
});

export async function measureNodeinfoStatistics(now = Date.now()): Promise<NodeinfoStatistics> {
  const db = getDb();
  const [localRows, [externalAll], [externalReplies], externalActors] = await Promise.all([
    db
      .select({ isReply: posts.isReply, n: count() })
      .from(posts)
      .where(
        sql`${posts.federationActorUri} is null and ${posts.visibility} = 'public' and ${posts.status} = 'published'`,
      )
      .groupBy(posts.isReply),
    db.select({ n: count() }).from(posts).where(isNotNull(posts.federationActorUri)),
    db
      .select({ n: count() })
      .from(posts)
      .where(sql`${posts.federationActorUri} is not null and ${posts.isReply}`),
    countExternalActors(),
  ]);

  const localComments = localRows.find((row) => row.isReply)?.n ?? 0;
  const localPosts = localRows.find((row) => !row.isReply)?.n ?? 0;
  const externalComments = Math.min(externalReplies?.n ?? 0, externalAll?.n ?? 0);
  const externalPosts = (externalAll?.n ?? 0) - externalComments;

  return {
    measuredAt: now,
    local: split(localPosts, localComments),
    external: split(externalPosts, externalComments),
    combined: split(localPosts + externalPosts, localComments + externalComments),
    externalActors,
  };
}

/**
 * The namespaced `metadata` extension: local, external and combined figures in
 * one place so a consumer never has to guess which standard field is which.
 * Local users are absent by design (see the module comment).
 */
export function nodeinfoStatisticsExtension(stats: NodeinfoStatistics) {
  return {
    version: 2,
    measuredAt: new Date(stats.measuredAt).toISOString(),
    exact: true,
    posts: {
      local: stats.local.posts,
      external: stats.external.posts,
      combined: stats.combined.posts,
    },
    comments: {
      local: stats.local.comments,
      external: stats.external.comments,
      combined: stats.combined.comments,
    },
    externalActors: stats.externalActors,
    scope: 'content and actors known to this instance; not the wider fediverse',
  };
}
