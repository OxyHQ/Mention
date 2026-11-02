/**
 * Aggregate statistics behind `GET /nodeinfo/2.0` (#1748).
 *
 * ## Definitions (the counting unit is one stored `posts` row)
 *
 * - **Local**: carries NEITHER a `federation_actor_uri` NOR a
 *   `federation_activity_id` — authored here — counted only while
 *   `visibility = 'public'` and `status = 'published'`. Drafts, scheduled,
 *   deleted and non-public rows are never published, even as aggregates.
 * - **External**: carries either one (ActivityPub or atproto, bridged or imported
 *   rows included). The actor URI alone is NOT the boundary: measured on
 *   production, 99% of the rows without one had an activity id and URL, i.e.
 *   federated posts stored before the actor URI. `federation_activity_id` is
 *   unique, so a repeated delivery is one row.
 * - **Comment** = a row with `is_reply`; **post** = a row without it.
 * - Local and external are a disjoint partition, so `combined = local + external`.
 * - **External actors**: `federated_actors` rows (`uri` unique). An alias under a
 *   second URI is a second record, hence "known actor records", not distinct people.
 * - **Local users**: Oxy's per-deployment registered-account total (ADR 0052),
 *   read through `applicationAccountTotal()`; Mention registers its accounts with
 *   `applicationAccountRegistrationJob`. Omitted, never 0, while Oxy has no snapshot.
 *
 * ## Cost
 *
 * No statement scans `posts`: each side is one GROUP BY over a partial index
 * keyed by `is_reply` (`posts_local_kind_idx`, `posts_external_kind_idx`,
 * migration 0105), whose predicates are exactly the definitions above. The actor figure is the planner estimate (exact on a table
 * never analyzed) and is flagged separately.
 */
import { count, sql } from 'drizzle-orm';
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
  const [localRows, externalRows, externalActors] = await Promise.all([
    db
      .select({ isReply: posts.isReply, n: count() })
      .from(posts)
      .where(
        sql`${posts.federationActorUri} is null and ${posts.federationActivityId} is null and ${posts.visibility} = 'public' and ${posts.status} = 'published'`,
      )
      .groupBy(posts.isReply),
    db
      .select({ isReply: posts.isReply, n: count() })
      .from(posts)
      .where(
        sql`${posts.federationActorUri} is not null or ${posts.federationActivityId} is not null`,
      )
      .groupBy(posts.isReply),
    countExternalActors(),
  ]);

  const pick = (rows: { isReply: boolean; n: number }[], reply: boolean) =>
    rows.find((row) => row.isReply === reply)?.n ?? 0;
  const local = split(pick(localRows, false), pick(localRows, true));
  const external = split(pick(externalRows, false), pick(externalRows, true));

  return {
    measuredAt: now,
    local,
    external,
    combined: split(local.posts + external.posts, local.comments + external.comments),
    externalActors,
  };
}

/**
 * The namespaced `metadata` extension: local, external and combined figures in
 * one place so a consumer never has to guess which standard field is which.
 * Local users are absent by design (see the module comment).
 */
export interface NodeinfoLocalUsers {
  total: number;
  exact: boolean;
  /** ISO time Oxy computed the total. */
  computedAt: string;
  /** True when Oxy serves its last good value while a refresh is pending or failed. */
  stale: boolean;
}

/**
 * `usage.users` for the standard document: local registered accounts (Oxy) plus
 * the external actor records Mention knows, as one total. Local and external are
 * disjoint (a federated actor is never a local account), so they add. Omitted
 * unless BOTH are known: with Oxy's total missing, the sum would silently drop
 * the local half.
 */
export function nodeinfoCombinedUsers(
  stats: NodeinfoStatistics | undefined,
  users: NodeinfoLocalUsers | undefined,
): { total?: number } {
  if (!stats || !users) return {};
  return { total: users.total + stats.externalActors.count };
}

export function nodeinfoStatisticsExtension(stats: NodeinfoStatistics, users?: NodeinfoLocalUsers) {
  return {
    version: 3,
    /** The standard `usage` fields carry the combined totals; this object holds the split. */
    standardFields: 'combined',
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
    users: {
      local: users ?? null,
      external: stats.externalActors,
    },
    scope: 'content and actors known to this instance; not the wider fediverse',
  };
}
