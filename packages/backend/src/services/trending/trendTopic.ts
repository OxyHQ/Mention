/**
 * What the topic screen reads about ONE trend (`GET /trending/topic`).
 *
 * Everything here is either a stored fact about the current batch or a count
 * over public posts in the trend window. Nothing is generated: the screen
 * states numbers, and a reader can check them.
 *
 * A term that is not in the current batch answers with its term and nothing
 * else. Authors are only resolved for a live trend, for the same reason the
 * summary answers `{}` for one: an endpoint that lists the people posting about
 * any string a caller sends is an enumeration surface.
 */

import { and, asc, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import {
  MtnConfig,
  PostVisibility,
  type PostUser,
  type TrendGraphEdgeDTO,
  type TrendGraphNodeDTO,
  type TrendRelatedDTO,
  type TrendTopicResponse,
} from '@mention/shared-types';
import { getDb } from '../../db/postgres';
import { trendBatches, trending } from '../../db/schema/discovery';
import { posts } from '../../db/schema/posts';
import { openAudienceAuthorSql } from '../../db/userProfile/profileAudience';
import { sensitiveExcludeSql } from '../../mtn/feed/feedSafety';
import { logger } from '../../utils/logger';
import { resolveKnownUsers } from '../../utils/knownUsers';
import { loadVolumeSeries } from './trendDecoration';
import { loadTrendGraph } from './trendGraphQuery';
import { trendTermMatchSql } from './termSpace';

/** Most people shown for one topic. */
const TOP_AUTHORS = 5;
/** Most co-occurring trends shown for one topic. */
const RELATED_LIMIT = 6;

/**
 * The trends that co-occur with `term`, strongest association first.
 *
 * Edges are read in both directions and deduplicated by the other end, keeping
 * the strongest. An edge whose other end has no node is dropped rather than
 * shown with no volume behind it.
 */
export function relatedTrends(
  term: string,
  nodes: readonly TrendGraphNodeDTO[],
  edges: readonly TrendGraphEdgeDTO[],
  limit: number = RELATED_LIMIT,
): TrendRelatedDTO[] {
  const nodeByTerm = new Map(nodes.map((node) => [node.term, node]));
  const best = new Map<string, TrendRelatedDTO>();

  for (const edge of edges) {
    const other = edge.a === term ? edge.b : edge.b === term ? edge.a : null;
    if (!other) continue;
    const node = nodeByTerm.get(other);
    if (!node) continue;

    const candidate: TrendRelatedDTO = {
      term: other,
      ...(node.displayName ? { displayName: node.displayName } : {}),
      volume: node.volume,
      authorCount: node.authorCount,
      strength: edge.strength ?? 0,
    };
    const previous = best.get(other);
    if (!previous || candidate.strength > previous.strength) best.set(other, candidate);
  }

  return [...best.values()]
    .sort(
      (left, right) =>
        right.strength - left.strength ||
        right.volume - left.volume ||
        left.term.localeCompare(right.term),
    )
    .slice(0, limit);
}

/**
 * The people posting most about `term` in the trend window, most posts first.
 *
 * Same visibility rules as the trend feed: public, published, open-audience
 * authors and not sensitive. Fail-soft: a failed count costs the widget, not
 * the screen.
 */
async function loadTopAuthors(term: string, now: Date): Promise<PostUser[]> {
  try {
    const { windowMs } = MtnConfig.trending.detection;
    const postCount = sql<number>`count(*)`.mapWith(Number);
    const rows = await getDb()
      .select({ author: posts.oxyUserId, count: postCount })
      .from(posts)
      .where(
        and(
          trendTermMatchSql(term),
          gte(posts.createdAt, new Date(now.getTime() - windowMs)),
          eq(posts.status, 'published'),
          eq(posts.visibility, PostVisibility.PUBLIC),
          openAudienceAuthorSql(),
          sql`${posts.boostOf} is null`,
          sensitiveExcludeSql(),
          isNotNull(posts.oxyUserId),
        ),
      )
      .groupBy(posts.oxyUserId)
      .orderBy(desc(postCount), asc(posts.oxyUserId))
      .limit(TOP_AUTHORS);

    const ids = rows.flatMap((row) => (row.author ? [row.author] : []));
    const users = await resolveKnownUsers(ids);
    return ids.flatMap((id) => {
      const user = users.get(id);
      return user ? [user] : [];
    });
  } catch (error) {
    logger.warn('[Trending] Topic top-authors lookup failed', { error });
    return [];
  }
}

/** Everything the topic screen shows for `term`, from the latest batch. */
export async function getTrendTopic(
  term: string,
  now: Date = new Date(),
): Promise<TrendTopicResponse> {
  const db = getDb();
  const [latestBatch] = await db
    .select({ calculatedAt: trendBatches.calculatedAt })
    .from(trendBatches)
    .orderBy(desc(trendBatches.calculatedAt))
    .limit(1);
  if (!latestBatch) return { term, topAuthors: [], related: [] };

  const [row] = await db
    .select({
      displayName: trending.displayName,
      category: trending.category,
      startedAt: trending.startedAt,
      firstSeenAt: trending.firstSeenAt,
      volume: trending.volume,
      authorCount: trending.authorCount,
      momentum: trending.momentum,
      status: trending.status,
      scope: trending.scope,
      languages: trending.languages,
      regions: trending.regions,
    })
    .from(trending)
    .where(and(eq(trending.name, term), eq(trending.calculatedAt, latestBatch.calculatedAt)))
    .limit(1);
  // Not in the current batch: no run to attribute anything to.
  if (!row) return { term, topAuthors: [], related: [] };

  const [series, topAuthors, graph] = await Promise.all([
    loadVolumeSeries([{ name: term }]),
    loadTopAuthors(term, now),
    loadTrendGraph({}).catch((error: unknown) => {
      logger.warn('[Trending] Topic graph lookup failed', { error });
      return null;
    }),
  ]);

  return {
    term,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.category ? { category: row.category } : {}),
    updatedAt: latestBatch.calculatedAt.toISOString(),
    windowHours: Math.round(MtnConfig.trending.detection.windowMs / (60 * 60 * 1000)),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.firstSeenAt ? { firstSeenAt: row.firstSeenAt.toISOString() } : {}),
    volume: row.volume ?? 0,
    authorCount: row.authorCount ?? 0,
    momentum: row.momentum ?? 0,
    ...(row.status ? { status: row.status } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    languages: row.languages ?? [],
    regions: row.regions ?? [],
    ...(series.get(term) ? { series: series.get(term) } : {}),
    topAuthors,
    related: graph ? relatedTrends(term, graph.nodes, graph.edges) : [],
  };
}
