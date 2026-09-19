import express, { Request, Response } from "express";
import { and, desc, eq, gte, max, sql } from 'drizzle-orm';
import { HASHTAG_TOKEN_SOURCE } from "@mention/shared-types/hashtags";
import { getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { notCollapsedCrosspostSql } from '../utils/feedQueryBuilder';
import { CHRONO_DESC, findPostRecords } from '../db/posts/postRepository';
import { getTrendingHashtags, type TrendingHashtagRow } from '../services/trendingHashtagsCache';
import {
  countTagsInWindow,
  searchHashtagsWithCounts,
  taggedPublicPosts,
  UNNESTED_TAG,
} from '../services/search/hashtagSearch';
import { resolveVariant } from "../services/postVariants";
import { logger } from "../utils/logger";
import { queryInt, queryString } from "../utils/queryParams";

const router = express.Router();

/** Default page size for `GET /hashtags/search` when `?limit` is absent. */
const HASHTAG_SEARCH_DEFAULT_LIMIT = 20;

/** Hard cap on the `GET /hashtags/search` page size — `?limit` can only narrow it. */
const HASHTAG_SEARCH_MAX_LIMIT = 50;

/**
 * Suggestion cap for the LEGACY `POST /hashtags/search` (tag-names-only) response.
 * Pinned to the historical value so pre-pagination clients see no change.
 */
const LEGACY_HASHTAG_SEARCH_LIMIT = 5;

/**
 * Trending rows returned, and the hard ceiling `?limit` can only narrow.
 *
 * Exported because it is HALF OF THE CACHE KEY: a test isolating cases by
 * `limit` would find them all collapsing to this one value.
 */
export const TRENDING_HASHTAG_LIMIT = 10;

/** Trailing window for trending counts when `?days` is absent. */
const DEFAULT_TRENDING_WINDOW_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseSearchQuery(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

// Public routes
// Get all hashtags
router.get("/", async (req: Request, res: Response) => {
  try {
    // Default to TRENDING_HASHTAG_LIMIT and enforce it as the maximum. An
    // unparseable `?limit` used to reach the aggregation as `$limit: NaN` (a 500).
    const limit = Math.max(1, Math.min(queryInt(req.query.limit) || TRENDING_HASHTAG_LIMIT, TRENDING_HASHTAG_LIMIT));

    // An unparseable `?days` keeps its long-standing meaning of "no time window"
    // (all-time counts); only an absent one falls back to the default window.
    const rawDays = queryString(req.query.days) ?? String(DEFAULT_TRENDING_WINDOW_DAYS);
    const days = Number.parseInt(rawDays, 10);
    const since = Number.isNaN(days) ? undefined : new Date(Date.now() - days * MS_PER_DAY);

    // CACHED, stale-while-revalidate. Everything below is the `compute` this
    // endpoint used to run on every request: three full `unnest` + `GROUP BY`
    // aggregates over every public tagged post in the window — ~454ms measured
    // on 400k posts, all of it a sequential scan. The answer depends only on
    // `limit` and `days`, never on the viewer, so one entry serves everyone;
    // `services/trendingHashtagsCache.ts` carries the safety argument and why a
    // cache rather than the denormalized table that was planned.
    const hashtags = await getTrendingHashtags(
      limit,
      Number.isNaN(days) ? undefined : days,
      async (): Promise<TrendingHashtagRow[]> => {
    // Primary window aggregation (overall within optional `days`)
    const windowRows = await getDb()
      .select({
        tag: UNNESTED_TAG,
        count: sql<number>`count(*)::int`,
        latest: max(posts.createdAt),
      })
      .from(posts)
      .innerJoin(sql`lateral unnest(${posts.hashtags}) as tag(value)`, sql`true`)
      .where(taggedPublicPosts(since ? gte(posts.createdAt, since) : undefined))
      .groupBy(UNNESTED_TAG)
      .orderBy(desc(sql`count(*)`), desc(max(posts.createdAt)))
      .limit(limit);

    let agg: Array<{
      id: string;
      text: string;
      hashtag: string;
      count: number;
      created_at: Date;
      direction?: 'up' | 'down' | 'flat';
    }> = windowRows.map((row) => ({
      id: row.tag,
      text: row.tag,
      hashtag: `#${row.tag}`,
      count: row.count,
      created_at: row.latest ?? new Date(0),
    }));

    // Trend direction (recent vs previous 24h windows)
    const now = new Date();
    const recentStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const prevStart = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    const [recentMap, prevMap] = await Promise.all([
      countTagsInWindow(recentStart),
      countTagsInWindow(prevStart, recentStart),
    ]);
    agg = agg.map((x) => {
      const id = (x.id || '').toLowerCase();
      const r = recentMap.get(id) || 0;
      const p = prevMap.get(id) || 0;
      let direction: 'up' | 'down' | 'flat' = 'flat';
      if (r > p) direction = 'up'; else if (p > r) direction = 'down';
      return { ...x, direction };
    });

    // Fallback: if no stored hashtags yet, derive from post content.text.
    // This scans post bodies and regex-extracts inline #tags, so it MUST stay
    // bounded — an unbounded scan would load every public text post into memory.
    // Two guards: a recent-window floor on `createdAt` (never wider than
    // FALLBACK_WINDOW_MS, even when no `days` filter was supplied) and a hard
    // document cap via `.limit()` on the newest posts.
    if (!agg || agg.length === 0) {
      const FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
      const FALLBACK_SCAN_LIMIT = 1000;
      const fallbackFloor = new Date(Date.now() - FALLBACK_WINDOW_MS);
      // Honor a caller-supplied window but never let it exceed the floor.
      const fallbackSince = since && since > fallbackFloor ? since : fallbackFloor;
      const scanned = await findPostRecords(
        and(
          eq(posts.visibility, 'public'),
          notCollapsedCrosspostSql(),
          gte(posts.createdAt, fallbackSince),
        ),
        { orderBy: CHRONO_DESC, limit: FALLBACK_SCAN_LIMIT },
      );
      const counts: Record<string, { c: number; latest: Date }> = {};
      for (const p of scanned) {
        // Scan the PRIMARY rendition: an author writing the same post in two
        // languages uses the same hashtags in both, so counting every variant
        // would double-count the tag for a bilingual post. A post with no
        // rendition resolves to an empty body and contributes nothing, which is
        // what the `content.variants.0` existence probe used to express.
        const text: string = resolveVariant(p.content).text;
        const createdAt = p.createdAt;
        // Same shared hashtag definition the extractor and the linkifiers use,
        // so this fallback cannot count a different set of tags than the stored
        // one. Occurrences are NOT deduplicated here — a tag repeated within a
        // post counts once per use, which is what the primary aggregation does.
        const matches = text.match(new RegExp(HASHTAG_TOKEN_SOURCE, 'gu')) || [];
        for (const raw of matches) {
          const tag = raw.replace(/^#/, '').toLowerCase();
          if (!counts[tag]) counts[tag] = { c: 0, latest: createdAt };
          counts[tag].c += 1;
          if (createdAt > counts[tag].latest) counts[tag].latest = createdAt;
        }
      }
      const fallbackArr = Object.entries(counts)
        .map(([id, v]) => ({ id, text: id, hashtag: `#${id}`, count: v.c, created_at: v.latest }))
        .sort((a, b) => (b.count - a.count) || (b.created_at.getTime() - a.created_at.getTime()))
        .slice(0, limit);
      // Compute simple direction for fallback (no previous window available): mark as 'up' if count > 0
      agg = fallbackArr.map((x) => ({ ...x, direction: (x.count > 0 ? 'up' : 'flat') as 'up' | 'flat' }));
    }

        // `created_at` is serialized HERE, not left as a `Date`.
        //
        // The value round-trips through JSON in Redis, so a cached entry would
        // come back as a string while a freshly computed one stayed a `Date` —
        // and `res.json` renders both identically, so the wire format would be
        // right either way and the TYPE would silently differ for anything
        // reading it in-process. Converting on the way in makes the two paths
        // produce the same thing. (`db/schema/CONVENTIONS.md` records the same
        // trap one layer down, where `db.execute` bypasses drizzle's mappers.)
        return agg.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
      },
    );

    res.json({ hashtags });
  } catch (error) {
    logger.error('[Hashtags] Error fetching hashtags:', { error, query: req.query });
    res.status(500).json({ message: "Error fetching hashtags from posts", error });
  }
});

// Search hashtags — returns each matching tag WITH its post count, so a result
// row can show "N posts" instead of a hardcoded zero. Offset-paginated so the
// search tab can load past the first page; `pagination.hasMore` drives the
// infinite scroll, `offset`/`limit` echo the effective window.
router.get('/search', async (req: Request, res: Response) => {
  const query = parseSearchQuery(req.query.query);
  if (!query) {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'Search query is required'
    });
  }

  // Clamp to a bounded window: an unparseable/absent `?limit` falls back to the
  // default; a negative/tampered `?offset` floors at 0. `$limit: offset + limit`
  // stays sane no matter what the client sends.
  const offset = Math.max(0, queryInt(req.query.offset) ?? 0);
  const limit = Math.min(Math.max(1, queryInt(req.query.limit) || HASHTAG_SEARCH_DEFAULT_LIMIT), HASHTAG_SEARCH_MAX_LIMIT);

  try {
    const { results, hasMore } = await searchHashtagsWithCounts(query, offset, limit);
    return res.json({ hashtags: results, pagination: { offset, limit, hasMore } });
  } catch (error) {
    logger.error('[Hashtags] Error searching hashtags:', { error, searchQuery: query });
    return res.status(500).json({
      error: 'Server error',
      message: 'Error searching hashtags'
    });
  }
});

// Legacy hashtag search kept for app builds shipped before `GET /hashtags/search`
// existed: those clients expect a bare array of tag NAMES under `data` and would
// break on the richer `{ tag, count }` shape. New callers must use the GET above.
router.post('/search', async (req: Request, res: Response) => {
  const query = parseSearchQuery((req.body as { query?: unknown } | undefined)?.query);
  if (!query) {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'Search query is required'
    });
  }

  try {
    const { results } = await searchHashtagsWithCounts(query, 0, LEGACY_HASHTAG_SEARCH_LIMIT);
    return res.json({ data: results.map((hashtag) => hashtag.tag) });
  } catch (error) {
    logger.error('[Hashtags] Error in searchHashtags:', { error, searchQuery: query });
    return res.status(500).json({
      error: 'Server error',
      message: 'Error searching hashtags'
    });
  }
});

export default router;
