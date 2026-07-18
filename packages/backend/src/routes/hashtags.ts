import express, { Request, Response } from "express";
import Post from "../models/Post";
import { resolveVariant } from "../services/postVariants";
import { logger } from "../utils/logger";
import { escapeRegex } from "../utils/textProcessing";
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

/** Upper bound on the raw query we turn into a regex. */
const HASHTAG_QUERY_MAX_LENGTH = 64;

/** Trending hashtags per page — also the cap, so `?limit` can only narrow it. */
const TRENDING_HASHTAG_LIMIT = 10;

/** Trailing window for trending counts when `?days` is absent. */
const DEFAULT_TRENDING_WINDOW_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface HashtagSearchResult {
  tag: string;
  count: number;
}

/** One page of hashtag matches plus whether a further page exists. */
interface HashtagSearchPage {
  results: HashtagSearchResult[];
  hasMore: boolean;
}

/**
 * One page of matching public hashtags with the number of posts carrying each.
 *
 * The query is regex-ESCAPED before it reaches Mongo — a raw user string would
 * otherwise be interpreted as a pattern (regex injection / catastrophic
 * backtracking).
 *
 * Paging is a stable keyset: the `{ count desc, tag asc }` sort is fully
 * deterministic (the grouped `_id` — the tag — breaks count ties), so `$skip`
 * offsets never shuffle rows between pages. One extra row is over-fetched
 * (`$limit: limit + 1`) purely to detect `hasMore` without a second count query.
 */
async function searchHashtagsWithCounts(rawQuery: string, offset: number, limit: number): Promise<HashtagSearchPage> {
  const needle = escapeRegex(rawQuery.trim().toLowerCase().slice(0, HASHTAG_QUERY_MAX_LENGTH));

  const rows = await Post.aggregate<HashtagSearchResult>([
    { $match: { visibility: 'public', hashtags: { $exists: true, $ne: [] } } },
    { $unwind: '$hashtags' },
    { $project: { tag: { $toLower: '$hashtags' } } },
    { $match: { tag: { $regex: needle, $options: 'i' } } },
    { $group: { _id: '$tag', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $skip: offset },
    { $limit: limit + 1 },
    { $project: { _id: 0, tag: '$_id', count: 1 } }
  ]);

  const hasMore = rows.length > limit;
  return { results: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

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

    const match: Record<string, unknown> = {
      visibility: 'public',
      hashtags: { $exists: true, $ne: [] }
    };
    if (since) {
      match.createdAt = { $gte: since };
    }

    // Primary window aggregation (overall within optional `days`)
    let agg = await Post.aggregate<{ id: string; text: string; hashtag: string; count: number; created_at: Date; direction?: 'up' | 'down' | 'flat' }>([
      { $match: match },
      { $unwind: '$hashtags' },
      {
        $group: {
          _id: { $toLower: '$hashtags' },
          count: { $sum: 1 },
          latest: { $max: '$createdAt' }
        }
      },
      { $sort: { count: -1, latest: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          id: '$_id',
          text: '$_id',
          hashtag: { $concat: ['#', '$_id'] },
          count: 1,
          created_at: '$latest'
        }
      }
    ]);

    // Trend direction (recent vs previous 24h windows)
    const now = new Date();
    const recentStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const prevStart = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    const recentAgg = await Post.aggregate<{ _id: string; c: number }>([
      { $match: { visibility: 'public', hashtags: { $exists: true, $ne: [] }, createdAt: { $gte: recentStart } } },
      { $unwind: '$hashtags' },
      { $group: { _id: { $toLower: '$hashtags' }, c: { $sum: 1 } } }
    ]);
    const prevAgg = await Post.aggregate<{ _id: string; c: number }>([
      { $match: { visibility: 'public', hashtags: { $exists: true, $ne: [] }, createdAt: { $gte: prevStart, $lt: recentStart } } },
      { $unwind: '$hashtags' },
      { $group: { _id: { $toLower: '$hashtags' }, c: { $sum: 1 } } }
    ]);
    const recentMap = new Map<string, number>(recentAgg.map((x) => [x._id, x.c]));
    const prevMap = new Map<string, number>(prevAgg.map((x) => [x._id, x.c]));
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
      const textMatch: Record<string, unknown> = {
        visibility: 'public',
        // A post with at least one rendition. The body lives only in the
        // variants, so "has text" is "has a variant".
        'content.variants.0': { $exists: true },
        createdAt: { $gte: fallbackSince },
      };
      const posts = await Post.find(textMatch)
        .select({ 'content.variants': 1, createdAt: 1 })
        .sort({ createdAt: -1 })
        .limit(FALLBACK_SCAN_LIMIT)
        .lean();
      const counts: Record<string, { c: number; latest: Date }> = {};
      for (const p of posts) {
        // Scan the PRIMARY rendition: an author writing the same post in two
        // languages uses the same hashtags in both, so counting every variant
        // would double-count the tag for a bilingual post.
        const text: string = resolveVariant(p.content).text;
        // `IPost.createdAt` is declared as a string but mongoose stores a Date;
        // normalize to a Date for comparison/sorting.
        const createdAt = new Date(p.createdAt);
        const matches = text.match(/#([A-Za-z0-9_]+)/g) || [];
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

    res.json({ hashtags: agg });
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
