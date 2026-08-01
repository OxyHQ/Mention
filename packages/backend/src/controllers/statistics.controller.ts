import { Response } from "express";
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getBaseLanguage, getPrimaryLanguage } from '@oxyhq/core';
import { and, asc, desc, eq, gte, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { PostType, PostVisibility } from '@mention/shared-types';
import { qualified } from '../db/casing';
import { getDb, type Transaction } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postAuthorships, postContentVariants } from '../db/schema/postContent';
import { userSettings } from '../db/schema/userProfile';
import { logger } from '../utils/logger';
import { aliaChat, isAliaEnabled } from '../utils/alia';
import { getRuntimeOxyClient } from '../runtime/oxyClient';
import { userPreferenceService } from '../services/UserPreferenceService';
import { recordDedupedView } from '../services/feedViewCounter';
import { validateRequired } from '../utils/apiHelpers';
import { queryInt } from '../utils/queryParams';
import { checkFollowAccess, requiresAccessCheck, ProfileVisibility } from '../utils/privacyHelpers';

/**
 * Language the AI weekly summary is written in when the viewer's Oxy account
 * declares no language (ISO 639-1 base code, matching what the prompt expects).
 */
const DEFAULT_SUMMARY_LANGUAGE = 'en';

/** Trailing window the statistics endpoints report on when `?days` is absent. */
const DEFAULT_STATS_WINDOW_DAYS = 30;
const MAX_STATS_WINDOW_DAYS = 366;
const STATISTICS_QUERY_MAX_TIME_MS = 3_000;
const STATISTICS_CACHE_TTL_MS = 30_000;
const STATISTICS_CACHE_MAX_ENTRIES = 500;

/** How many posts the `topPosts` leaderboard returns. */
const TOP_POSTS_LIMIT = 10;

/**
 * `sum(column)` as a JS NUMBER.
 *
 * Postgres widens `sum(integer)` to `bigint`, and postgres.js hands a `bigint`
 * back as a STRING — which `res.json` would ship as `"41"` where Mongo's
 * `$sum` shipped `41`. `mapWith(Number)` is what keeps the wire type unchanged;
 * `coalesce` supplies Mongo's "no matching documents ⇒ 0" rather than `null`.
 */
function sumOf(column: AnyPgColumn): SQL<number> {
  return sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
}

/** `count(*)` as a JS number, for the same bigint-is-a-string reason. */
function countAll(): SQL<number> {
  return sql<number>`count(*)`.mapWith(Number);
}

/**
 * The UTC day a post belongs to, formatted exactly as Mongo's
 * `$dateToString { format: '%Y-%m-%d', timezone: 'UTC' }` produced it.
 *
 * The response ships `{ date: string }` and the client renders it, so this is a
 * wire format, not an internal grouping key. `at time zone 'UTC'` converts the
 * `timestamptz` to a UTC wall-clock timestamp and `to_char` zero-pads every
 * field, which is what `%Y-%m-%d` did. It goes through the query BUILDER rather
 * than `db.execute` on purpose: `db.execute` bypasses drizzle's column mappers,
 * and every other column in these rows is a count that would come back a string.
 */
const utcDayBucket = sql<string>`to_char(${posts.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

interface DateRange {
  startDate: Date;
  endDate: Date;
}

function getDateRange(days: number = DEFAULT_STATS_WINDOW_DAYS): DateRange {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  return { startDate, endDate };
}

function requestedStatsDays(value: unknown): number {
  const parsed = queryInt(value);
  return parsed === undefined
    ? DEFAULT_STATS_WINDOW_DAYS
    : Math.min(MAX_STATS_WINDOW_DAYS, Math.max(1, parsed));
}

/**
 * Run statistics reads inside one transaction carrying a statement timeout.
 *
 * This is the replacement for Mongoose's `.option({ maxTimeMS })` /
 * `.maxTimeMS()`, and it does a second job the Mongo version got for free: a
 * `$facet` was ONE operation over ONE snapshot, so its branches could not
 * disagree with each other. Four independent queries on four pooled connections
 * could — a post created between them would be counted by one branch and not
 * another. One transaction restores that.
 *
 * `set_config(..., true)` is the parameterisable spelling of `SET LOCAL`; `SET`
 * itself takes no bind parameters.
 */
async function withStatisticsTimeout<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(STATISTICS_QUERY_MAX_TIME_MS)}, true)`,
    );
    return run(tx);
  });
}

interface UserStatisticsPayload {
  period: { startDate: string; endDate: string; days: number };
  overview: {
    totalPosts: number;
    totalViews: number;
    totalInteractions: number;
    engagementRate: number;
    averageEngagementPerPost: number;
  };
  interactions: { likes: number; replies: number; boosts: number; shares: number };
  dailyBreakdown: Array<{
    date: string;
    views: number;
    likes: number;
    replies: number;
    boosts: number;
    interactions: number;
  }>;
  topPosts: Array<{
    postId: string;
    views: number;
    likes: number;
    replies: number;
    boosts: number;
    engagement: number;
    createdAt: Date;
  }>;
  postsByType: Record<string, number>;
}

const statisticsCache = new Map<
  string,
  { expiresAt: number; value: UserStatisticsPayload }
>();

function cacheStatistics(key: string, value: UserStatisticsPayload): void {
  statisticsCache.delete(key);
  statisticsCache.set(key, { expiresAt: Date.now() + STATISTICS_CACHE_TTL_MS, value });
  while (statisticsCache.size > STATISTICS_CACHE_MAX_ENTRIES) {
    const oldest = statisticsCache.keys().next().value as string | undefined;
    if (!oldest) break;
    statisticsCache.delete(oldest);
  }
}

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * The `$facet` translation.
 *
 * Mongo ran ONE `$match` (posts this user OWNS, created inside the window) and
 * then four INDEPENDENT sub-pipelines over the matched set. Those four answer at
 * four different GRAINS — one scalar row, a per-day series, a top-N row list,
 * and a per-type series — and Postgres has no single statement that returns all
 * four without either a lateral contortion or `json_agg`, and `json_agg` would
 * have to be read back through `db.execute`, which bypasses drizzle's column
 * mappers and would turn `topPosts[].createdAt` from a `Date` into whatever
 * string the driver felt like. So: four queries over the SAME predicate, in one
 * transaction (see {@link withStatisticsTimeout} for why the transaction, not
 * `Promise.all`, is the faithful shape).
 *
 * **The overview totals are their own query, deliberately.** The tempting
 * collapse is to read them off the `topPosts` branch — either as
 * `topRows.length` or as a `count(*) OVER ()` carried by its rows. Both make the
 * total a property of the PAGE rather than of the matched set: the first is
 * already wrong (it reports 10 for a user with 12 posts), and the second becomes
 * wrong the moment that branch grows an offset, because a window aggregate is
 * carried BY the returned rows and a page past the end returns none. Neither
 * failure raises anything; the response just says the user has less than they
 * have. The same reasoning is why `routes/customFeeds.routes.ts` counts its
 * paginated listings with a second query.
 */
async function queryUserStatistics(
  userId: string,
  days: number,
): Promise<UserStatisticsPayload> {
  const cacheKey = `${userId}:${days}`;
  const cached = statisticsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    statisticsCache.delete(cacheKey);
    statisticsCache.set(cacheKey, cached);
    return cached.value;
  }
  if (cached) statisticsCache.delete(cacheKey);

  const { startDate, endDate } = getDateRange(days);

  // The `$match`: `authorship: { $elemMatch: { oxyUserId, role: 'owner' } }`
  // became a join, and `post_authorships_one_owner_per_post` guarantees it
  // cannot fan a post out into two rows the way a naive join on a multi-valued
  // relation would.
  const ownedInWindow = and(
    eq(postAuthorships.oxyUserId, userId),
    eq(postAuthorships.role, 'owner'),
    gte(posts.createdAt, startDate),
    lte(posts.createdAt, endDate),
  );

  // `likes + replies + boosts + shares`, the `$add` both the daily and the
  // top-post branches computed. Integer arithmetic on integer columns, so it
  // needs no numeric mapping.
  const engagementExpr = sql<number>`(${posts.statsLikesCount} + ${posts.statsCommentsCount} + ${posts.statsBoostsCount} + ${posts.statsSharesCount})`;

  // `$ifNull: ['$type', 'text']` — a coalesced GROUP KEY, not a plain
  // `group by type`. `posts.type` is NOT NULL DEFAULT 'text' in this schema, so
  // the coalesce cannot change an answer today; it is kept because it is what
  // the source predicate says, and a nullable `type` arriving later must bucket
  // as `text` rather than silently forming a `null` key.
  const typeBucket = sql<string>`coalesce(${posts.type}, 'text')`;

  const facets = await withStatisticsTimeout(async (tx) => {
    const [overview] = await tx
      .select({
        totalPosts: countAll(),
        totalViews: sumOf(posts.statsViewsCount),
        totalLikes: sumOf(posts.statsLikesCount),
        totalReplies: sumOf(posts.statsCommentsCount),
        totalBoosts: sumOf(posts.statsBoostsCount),
        totalShares: sumOf(posts.statsSharesCount),
      })
      .from(posts)
      .innerJoin(postAuthorships, eq(postAuthorships.postId, posts.id))
      .where(ownedInWindow);

    const dailyRows = await tx
      .select({
        date: utcDayBucket,
        views: sumOf(posts.statsViewsCount),
        likes: sumOf(posts.statsLikesCount),
        replies: sumOf(posts.statsCommentsCount),
        boosts: sumOf(posts.statsBoostsCount),
        shares: sumOf(posts.statsSharesCount),
      })
      .from(posts)
      .innerJoin(postAuthorships, eq(postAuthorships.postId, posts.id))
      .where(ownedInWindow)
      .groupBy(utcDayBucket)
      // `$sort: { date: 1 }` sorted the FORMATTED string; so does this. The two
      // orders coincide because `YYYY-MM-DD` is lexicographically chronological.
      .orderBy(asc(utcDayBucket));

    const topRows = await tx
      .select({
        postId: posts.id,
        views: posts.statsViewsCount,
        likes: posts.statsLikesCount,
        replies: posts.statsCommentsCount,
        boosts: posts.statsBoostsCount,
        engagement: engagementExpr,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .innerJoin(postAuthorships, eq(postAuthorships.postId, posts.id))
      .where(ownedInWindow)
      // `id` is not pagination protection (there is no offset here — this is one
      // bounded leaderboard); it makes WHICH posts tie into the last slot
      // reproducible instead of plan-dependent. Mongo left that arbitrary.
      .orderBy(desc(engagementExpr), desc(posts.createdAt), desc(posts.id))
      .limit(TOP_POSTS_LIMIT);

    const typeRows = await tx
      .select({ type: typeBucket, count: countAll() })
      .from(posts)
      .innerJoin(postAuthorships, eq(postAuthorships.postId, posts.id))
      .where(ownedInWindow)
      .groupBy(typeBucket)
      // Mongo left this unordered, which made the key order of `postsByType`
      // depend on the plan. Ordering costs nothing on a handful of groups.
      .orderBy(asc(typeBucket));

    return { overview, dailyRows, topRows, typeRows };
  });

  const totals = facets.overview;
  const totalInteractions =
    totals.totalLikes + totals.totalReplies + totals.totalBoosts + totals.totalShares;
  const value: UserStatisticsPayload = {
    period: {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      days,
    },
    overview: {
      totalPosts: totals.totalPosts,
      totalViews: totals.totalViews,
      totalInteractions,
      engagementRate: rounded(
        totals.totalViews > 0 ? (totalInteractions / totals.totalViews) * 100 : 0,
      ),
      averageEngagementPerPost: rounded(
        totals.totalPosts > 0 ? totalInteractions / totals.totalPosts : 0,
      ),
    },
    interactions: {
      likes: totals.totalLikes,
      replies: totals.totalReplies,
      boosts: totals.totalBoosts,
      shares: totals.totalShares,
    },
    // `shares` fed the `interactions` sum and was then `$unset` — it is summed
    // here and dropped from the emitted row for the same reason.
    dailyBreakdown: facets.dailyRows.map((row) => ({
      date: row.date,
      views: row.views,
      likes: row.likes,
      replies: row.replies,
      boosts: row.boosts,
      interactions: row.likes + row.replies + row.boosts + row.shares,
    })),
    topPosts: facets.topRows.map((row) => ({
      postId: row.postId,
      views: row.views,
      likes: row.likes,
      replies: row.replies,
      boosts: row.boosts,
      engagement: row.engagement,
      createdAt: row.createdAt,
    })),
    postsByType: Object.fromEntries(
      facets.typeRows.map(({ type, count }) => [type, count]),
    ),
  };
  cacheStatistics(cacheKey, value);
  return value;
}

/**
 * Get user statistics (overall analytics)
 * Shows post views, interactions, follower changes, and engagement ratios
 */
export const getUserStatistics = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const days = requestedStatsDays(req.query.days);
    res.json(await queryUserStatistics(userId, days));
  } catch (error) {
    logger.error('Error fetching user statistics:', error);
    res.status(500).json({
      message: 'Error fetching user statistics',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Get a user's posting activity bucketed per UTC day (GitHub-style heatmap).
 *
 * PUBLIC profile data — keyed by the `:userId` path param, the same way public
 * profile stats (follower counts, profile-design counts) are exposed. Optional
 * auth: `req.user` is populated when a session is present but never required.
 * The target user's profile visibility is respected exactly like the public
 * profile-design counts: a private / followers-only profile returns an empty
 * activity set unless the viewer is the owner or an approved follower.
 */
export const getUserActivity = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.params.userId as string;
    const validationError = validateRequired(userId, 'userId');
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    // Clamp the requested window to a sane range. Default 365 (a full year of the
    // heatmap); min 30, max 366.
    const rawDays = queryInt(req.query.days);
    const days = rawDays === undefined ? 365 : Math.min(366, Math.max(30, rawDays));

    // Respect the target user's profile visibility — mirrors the public
    // profile-design stats. For a private / followers-only profile the viewer
    // must be the owner or an approved follower; otherwise the activity is empty.
    const currentUserId = req.user?.id;
    if (currentUserId !== userId) {
      const [settings] = await getDb()
        .select({ profileVisibility: userSettings.privacyProfileVisibility })
        .from(userSettings)
        .where(eq(userSettings.oxyUserId, userId))
        .limit(1);
      const profileVisibility = settings?.profileVisibility || ProfileVisibility.PUBLIC;
      if (requiresAccessCheck(profileVisibility)) {
        if (!currentUserId) {
          return res.json({ activity: [] });
        }
        const hasAccess = await checkFollowAccess(currentUserId, userId);
        if (!hasAccess) {
          return res.json({ activity: [] });
        }
      }
    }

    // Window boundary in UTC — end of today minus `days`. The request timezone is
    // never read; both the boundary and the per-day buckets are computed in UTC.
    const now = new Date();
    const endOfToday = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999
    ));
    const startDate = new Date(endOfToday.getTime() - days * 24 * 60 * 60 * 1000);

    // Count authored posts per UTC day: original posts + replies + quotes, but
    // NOT boosts/reposts (a repost is a `type: 'boost'` post that carries no
    // authored content). Scoped to the user's public, published posts so it stays
    // consistent with the public profile-design counts and never leaks
    // followers-only/private content. Only days with count > 0 are returned; the
    // client fills the gaps.
    //
    // Keyed on the DENORMALIZED `posts.oxy_user_id`, not the authorship join the
    // owner statistics above use — that is what the Mongo query did, and the two
    // answer different questions (this one excludes posts a user only
    // collaborates on).
    const activity = await withStatisticsTimeout((tx) =>
      tx
        .select({ date: utcDayBucket, count: countAll() })
        .from(posts)
        .where(
          and(
            eq(posts.oxyUserId, userId),
            eq(posts.visibility, PostVisibility.PUBLIC),
            eq(posts.status, 'published'),
            ne(posts.type, PostType.BOOST),
            gte(posts.createdAt, startDate),
          ),
        )
        .groupBy(utcDayBucket)
        .orderBy(asc(utcDayBucket)),
    );

    res.json({ activity });
  } catch (error) {
    logger.error('Error fetching user activity:', error);
    res.status(500).json({
      message: 'Error fetching user activity',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Get post-specific insights
 * Shows views, likes, replies, reach, and engagement for a specific post
 */
export const getPostInsights = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { postId } = req.params;

    const insights = await withStatisticsTimeout(async (tx) => {
      const [post] = await tx
        .select({
          id: posts.id,
          oxyUserId: posts.oxyUserId,
          createdAt: posts.createdAt,
          likesCount: posts.statsLikesCount,
          boostsCount: posts.statsBoostsCount,
          commentsCount: posts.statsCommentsCount,
          viewsCount: posts.statsViewsCount,
          sharesCount: posts.statsSharesCount,
        })
        .from(posts)
        .where(eq(posts.id, String(postId)))
        .limit(1);
      if (!post) return null;
      if (post.oxyUserId !== userId) return { post, forbidden: true as const };

      // Three `countDocuments` calls became ONE query with three `FILTER`
      // aggregates: the three predicates read the same table and the union of
      // them is the rows worth scanning at all. Every column here belongs to
      // `posts`, which IS in this statement's FROM, so the bare renderings are
      // correct — `qualified()` is for a correlated reference, and there is none.
      const [related] = await tx
        .select({
          replies: sql<number>`count(*) filter (where ${posts.parentPostId} = ${post.id})`.mapWith(Number),
          boosts: sql<number>`count(*) filter (where ${posts.boostOf} = ${post.id})`.mapWith(Number),
          quotes: sql<number>`count(*) filter (where ${posts.quoteOf} = ${post.id})`.mapWith(Number),
        })
        .from(posts)
        .where(
          or(
            eq(posts.parentPostId, post.id),
            eq(posts.boostOf, post.id),
            eq(posts.quoteOf, post.id),
          ),
        );

      return { post, forbidden: false as const, related };
    });

    if (!insights) {
      return res.status(404).json({ message: 'Post not found' });
    }
    if (insights.forbidden) {
      return res.status(403).json({ message: 'You can only view insights for your own posts' });
    }

    const { post, related } = insights;

    // Calculate engagement metrics. The counters are `NOT NULL DEFAULT 0`
    // columns, so the `post.stats || { … }` fallback the Mongo version needed
    // for a document with no `stats` subdocument has nothing left to guard.
    const totalInteractions = post.likesCount + post.commentsCount + post.boostsCount + post.sharesCount;
    const engagementRate = post.viewsCount > 0
      ? (totalInteractions / post.viewsCount) * 100
      : 0;

    res.json({
      postId: post.id,
      createdAt: post.createdAt,
      stats: {
        views: post.viewsCount,
        likes: post.likesCount,
        replies: related.replies,
        boosts: related.boosts,
        quotes: related.quotes,
        shares: post.sharesCount
      },
      engagement: {
        totalInteractions,
        engagementRate: parseFloat(engagementRate.toFixed(2)),
        // Reach is the measured view counter. Mention does not currently retain
        // a durable lifetime unique-viewer set, so that metric is explicit null
        // rather than a fabricated estimate.
        reach: post.viewsCount,
        uniqueViewers: null,
      },
      breakdown: {
        likedBy: post.likesCount,
        hasReplies: related.replies > 0,
        hasBoosts: related.boosts > 0,
        hasQuotes: related.quotes > 0
      }
    });
  } catch (error) {
    logger.error('Error fetching post insights:', error);
    res.status(500).json({
      message: 'Error fetching post insights',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Track post view
 * Increments view count when a user views a post
 */
export const trackPostView = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const postId = req.params.postId as string;

    if (!postId) {
      return res.status(400).json({ message: 'Post ID is required' });
    }

    // Deduplicate the view per (viewer, post) through the SAME canonical
    // feed-impression guard used by ranking (`recordDedupedView` → Redis
    // `SET NX EX viewseen:<post>:<viewer>`): only the FIRST view within the
    // window performs the `$inc` on `stats.viewsCount`; a duplicate view or an
    // ineligible/absent post is a no-op. This closes the previous
    // undeduplicated `$inc`-on-any-postId inflation path. An anonymous request
    // (no viewer id) cannot be deduped, so — matching `feedViewCounter`, which
    // requires a viewer id — it is never counted.
    if (userId) {
      await recordDedupedView(postId, userId);
    }

    // Read back the current count for the response; this also serves as the
    // existence check, so a missing post still returns 404.
    const [post] = await getDb()
      .select({ viewsCount: posts.statsViewsCount })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Best-effort preference learning — detached so it never adds latency to the
    // view response.
    if (userId) {
      void userPreferenceService
        .recordInteraction(userId, postId, 'view')
        .catch((error) => logger.warn('Failed to record view interaction:', error));
    }

    res.json({ success: true, viewsCount: post.viewsCount });
  } catch (error) {
    logger.error('Error tracking post view:', error);
    res.status(500).json({
      message: 'Error tracking post view',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Get follower changes over time
 * Shows follower growth/loss trends
 */
export const getFollowerChanges = async (req: AuthRequest, res: Response) => {
  if (!req.user?.id) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  return res.status(501).json({
    message: 'Follower history is unavailable until authoritative Oxy snapshots are enabled',
    available: false,
  });
};

/**
 * Get engagement ratios and performance metrics
 */
export const getEngagementRatios = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const days = requestedStatsDays(req.query.days);
    const statistics = await queryUserStatistics(userId, days);
    const totalViews = statistics.overview.totalViews;
    const totalInteractions = statistics.overview.totalInteractions;
    const totalLikes = statistics.interactions.likes;
    const totalReplies = statistics.interactions.replies;
    const totalBoosts = statistics.interactions.boosts;
    const totalShares = statistics.interactions.shares;
    const totalPosts = statistics.overview.totalPosts;

    // Calculate various engagement ratios
    const engagementRate = totalViews > 0 ? (totalInteractions / totalViews) * 100 : 0;
    const likeRate = totalViews > 0 ? (totalLikes / totalViews) * 100 : 0;
    const replyRate = totalViews > 0 ? (totalReplies / totalViews) * 100 : 0;
    const boostRate = totalViews > 0 ? (totalBoosts / totalViews) * 100 : 0;
    const shareRate = totalViews > 0 ? (totalShares / totalViews) * 100 : 0;

    // Calculate average per post
    const avgViewsPerPost = totalPosts > 0 ? totalViews / totalPosts : 0;
    const avgEngagementPerPost = totalPosts > 0 ? totalInteractions / totalPosts : 0;

    res.json({
      period: {
        ...statistics.period,
      },
      ratios: {
        engagementRate: parseFloat(engagementRate.toFixed(2)),
        likeRate: parseFloat(likeRate.toFixed(2)),
        replyRate: parseFloat(replyRate.toFixed(2)),
        boostRate: parseFloat(boostRate.toFixed(2)),
        shareRate: parseFloat(shareRate.toFixed(2))
      },
      averages: {
        viewsPerPost: parseFloat(avgViewsPerPost.toFixed(2)),
        engagementPerPost: parseFloat(avgEngagementPerPost.toFixed(2))
      },
      totals: {
        posts: totalPosts,
        views: totalViews,
        interactions: totalInteractions,
        likes: totalLikes,
        replies: totalReplies,
        boosts: totalBoosts,
        shares: totalShares
      }
    });
  } catch (error) {
    logger.error('Error fetching engagement ratios:', error);
    res.status(500).json({
      message: 'Error fetching engagement ratios',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Get AI-generated weekly summary
 * Computes current vs previous week stats and generates a personalized insight via Alia
 */
export const getWeeklySummary = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!isAliaEnabled()) {
      return res.json({ summary: null });
    }

    // Write the summary in the viewer's PRIMARY account language. Oxy stores
    // account languages as BCP-47 locales (`es-ES`), primary first; the prompt
    // wants the base ISO 639-1 code (`es`). English is the fallback when the
    // account declares no language or the profile fetch fails.
    let language = DEFAULT_SUMMARY_LANGUAGE;
    try {
      const oxyUser = await getRuntimeOxyClient().getUserById(userId);
      const primaryLocale = getPrimaryLanguage(oxyUser);
      const baseLanguage = primaryLocale ? getBaseLanguage(primaryLocale) : '';
      if (baseLanguage) {
        language = baseLanguage;
      }
    } catch (error) {
      logger.warn('[statistics] Failed to resolve viewer language for the weekly summary; using English', {
        userId,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }

    const { startDate } = getDateRange(14);
    const now = new Date();

    /**
     * The post's PRIMARY rendition body.
     *
     * `resolveVariant(content)` with no requested tag resolves to the primary
     * author variant, which the schema stores as `position = 0`
     * (`post_content_variants` — "0 is the PRIMARY"). Selecting it directly
     * beats loading every variant to throw all but one away.
     *
     * `qualified(posts.id)` is defensive, and this is the shape it defends
     * against: measured against drizzle's own output, a `sql` subquery in the
     * SELECT list of a single-table, JOIN-FREE statement renders every column
     * BARE — `where "post_id" = "id"` — so both names resolve against
     * `post_content_variants` and the subquery returns NULL for every post with
     * no error at all. This particular statement carries a join, which makes
     * drizzle qualify everything, so today the two spellings compile
     * identically; drop the join and the bare form starts losing data silently.
     */
    const primaryBody = sql<string | null>`(
      select ${postContentVariants.body}
      from ${postContentVariants}
      where ${postContentVariants.postId} = ${qualified(posts.id)}
        and ${postContentVariants.position} = 0
      limit 1
    )`;

    const postRows = await withStatisticsTimeout((tx) =>
      tx
        .select({
          createdAt: posts.createdAt,
          type: posts.type,
          views: posts.statsViewsCount,
          likes: posts.statsLikesCount,
          replies: posts.statsCommentsCount,
          boosts: posts.statsBoostsCount,
          primaryBody,
        })
        .from(posts)
        .innerJoin(postAuthorships, eq(postAuthorships.postId, posts.id))
        .where(
          and(
            eq(postAuthorships.oxyUserId, userId),
            eq(postAuthorships.role, 'owner'),
            gte(posts.createdAt, startDate),
            lte(posts.createdAt, now),
          ),
        ),
    );

    // Split into current week (last 7 days) and previous week (days 8-14)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const currentWeekPosts = postRows.filter(p => p.createdAt >= sevenDaysAgo);
    const previousWeekPosts = postRows.filter(p => p.createdAt < sevenDaysAgo);

    const computeStats = (postList: typeof postRows) => {
      const totalPosts = postList.length;
      const totalViews = postList.reduce((sum, p) => sum + p.views, 0);
      const likes = postList.reduce((sum, p) => sum + p.likes, 0);
      const replies = postList.reduce((sum, p) => sum + p.replies, 0);
      const boosts = postList.reduce((sum, p) => sum + p.boosts, 0);
      const totalInteractions = likes + replies + boosts;
      const engagementRate = totalViews > 0 ? (totalInteractions / totalViews) * 100 : 0;
      return { totalPosts, totalViews, totalInteractions, engagementRate, likes, replies, boosts };
    };

    const current = computeStats(currentWeekPosts);
    const previous = computeStats(previousWeekPosts);

    const delta = (cur: number, prev: number): string => {
      if (prev === 0) return cur > 0 ? '+100' : '0';
      return ((cur - prev) / prev * 100).toFixed(0);
    };

    // Skip AI call if the user had no activity in either week — nothing meaningful to summarize
    if (current.totalPosts === 0 && previous.totalPosts === 0) {
      return res.json({ summary: null });
    }

    // Determine which post type performed best this week
    const postTypeMap: Record<string, number> = {};
    for (const p of currentWeekPosts) {
      const type = p.type || 'text';
      postTypeMap[type] = (postTypeMap[type] || 0) + 1;
    }
    const topPostType = Object.entries(postTypeMap)
      .sort((a, b) => b[1] - a[1])[0];

    // Find the user's strongest interaction type this week
    const interactionRanking = [
      { type: 'likes', count: current.likes },
      { type: 'replies', count: current.replies },
      { type: 'boosts', count: current.boosts },
    ].sort((a, b) => b.count - a.count);
    const strongestInteraction = interactionRanking[0];
    const weakestInteraction = interactionRanking[interactionRanking.length - 1];

    // Format the week's date range for context
    const weekStart = new Date(sevenDaysAgo);
    const weekEnd = new Date();
    const formatDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const dateRange = `${formatDate(weekStart)} - ${formatDate(weekEnd)}`;

    const lines = [
      `Period: ${dateRange}.`,
      `This week: ${current.totalPosts} posts, ${current.totalViews} views, ${current.totalInteractions} interactions (${current.likes} likes, ${current.replies} replies, ${current.boosts} boosts), ${current.engagementRate.toFixed(1)}% engagement.`,
      `Previous week: ${previous.totalPosts} posts, ${previous.totalViews} views, ${previous.totalInteractions} interactions (${previous.likes} likes, ${previous.replies} replies, ${previous.boosts} boosts), ${previous.engagementRate.toFixed(1)}% engagement.`,
      `Week-over-week: views ${delta(current.totalViews, previous.totalViews)}%, interactions ${delta(current.totalInteractions, previous.totalInteractions)}%, posts ${delta(current.totalPosts, previous.totalPosts)}%.`,
    ];
    if (topPostType) {
      lines.push(`Most used post type this week: ${topPostType[0]} (${topPostType[1]} posts).`);
    }
    if (strongestInteraction.count > 0) {
      lines.push(`Strongest interaction: ${strongestInteraction.type} (${strongestInteraction.count}). Weakest: ${weakestInteraction.type} (${weakestInteraction.count}).`);
    }

    // Find the best-performing post this week by total engagement
    const bestPost = currentWeekPosts
      .map(p => ({
        engagement: p.likes + p.replies + p.boosts,
        views: p.views,
        type: p.type || 'text',
        // The primary rendition — an analytics snippet shows the author's own words.
        contentSnippet: (p.primaryBody ?? '').slice(0, 80),
      }))
      .sort((a, b) => b.engagement - a.engagement)[0];

    if (bestPost && bestPost.engagement > 0) {
      lines.push(`Best post this week: ${bestPost.type} post with ${bestPost.views} views and ${bestPost.engagement} interactions${bestPost.contentSnippet ? ` — "${bestPost.contentSnippet}${bestPost.contentSnippet.length >= 80 ? '...' : ''}"` : ''}.`);
    }

    // Find the most active day this week
    const dayActivity = new Map<string, number>();
    for (const p of currentWeekPosts) {
      const day = p.createdAt.toLocaleDateString('en-US', { weekday: 'long' });
      dayActivity.set(day, (dayActivity.get(day) || 0) + 1);
    }
    const mostActiveDay = [...dayActivity.entries()].sort((a, b) => b[1] - a[1])[0];
    if (mostActiveDay) {
      lines.push(`Most active day: ${mostActiveDay[0]} (${mostActiveDay[1]} posts).`);
    }

    const userMessage = lines.join('\n');

    try {
      const summary = await aliaChat(
        [
          {
            role: 'system',
            content: [
              'You write weekly performance summaries for Mention, a social media platform.',
              'You are speaking directly to the user about their personal stats for the given date range vs the previous week.',
              'Write exactly 2-3 sentences.',
              'First sentence: a concrete observation about their week — reference actual numbers and what changed.',
              'Second sentence: one specific, actionable growth tip based on what the data shows.',
              'Your growth tips should be based on how social media algorithms work:',
              '- Posts that get early replies and boosts get boosted by the algorithm, so encourage conversation-starting content.',
              '- Posting consistently (even 1 post/day) signals activity and improves reach over time.',
              '- Engagement rate matters more than raw views — a smaller audience that interacts is better than passive viewers.',
              '- If replies are low, suggest ending posts with questions or hot takes to spark discussion.',
              '- If boosts are low, suggest sharing insights, tips, or relatable content that people want to share.',
              '- If views are high but interactions are low, the content reaches people but does not resonate — suggest trying different formats or more personal/opinionated posts.',
              '- Mixing post types (text, images, polls) keeps the audience engaged.',
              'Pick the ONE most relevant tip for this user based on their specific data. Do not list multiple tips.',
              'Optional third sentence only for notable milestones or patterns.',
              'Tone: conversational and direct — like a smart friend reviewing your stats. No corporate speak, no motivational quotes, no exclamation marks, no emojis, no bullet points, no markdown.',
              'Address the user as "you" / "your". Never say "the user".',
              'If this week had zero posts, gently encourage posting again without guilt.',
              `Write the entire summary in the language with code "${language}". If you don't recognize the code, use English.`,
              'Return ONLY the summary text.',
            ].join(' '),
          },
          { role: 'user', content: userMessage },
        ],
        { model: 'alia-lite', temperature: 0.7, maxTokens: 200 },
      );

      return res.json({ summary });
    } catch (aiError) {
      logger.warn('Alia AI summary generation failed:', aiError);
      return res.json({ summary: null });
    }
  } catch (error) {
    logger.error('Error generating weekly summary:', error);
    res.status(500).json({
      message: 'Error generating weekly summary',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
