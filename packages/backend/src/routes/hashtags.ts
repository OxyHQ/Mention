import express, { Request, Response } from "express";
import Post from "../models/Post";
import { logger } from "../utils/logger";
import { escapeRegex } from "../utils/textProcessing";

const router = express.Router();

/** Max hashtag suggestions returned by either search endpoint. */
const HASHTAG_SEARCH_LIMIT = 5;

/** Upper bound on the raw query we turn into a regex. */
const HASHTAG_QUERY_MAX_LENGTH = 64;

export interface HashtagSearchResult {
  tag: string;
  count: number;
}

/**
 * Matching public hashtags with the number of posts carrying each one.
 *
 * The query is regex-ESCAPED before it reaches Mongo — a raw user string would
 * otherwise be interpreted as a pattern (regex injection / catastrophic
 * backtracking).
 */
async function searchHashtagsWithCounts(rawQuery: string): Promise<HashtagSearchResult[]> {
  const needle = escapeRegex(rawQuery.trim().toLowerCase().slice(0, HASHTAG_QUERY_MAX_LENGTH));

  return Post.aggregate<HashtagSearchResult>([
    { $match: { visibility: 'public', hashtags: { $exists: true, $ne: [] } } },
    { $unwind: '$hashtags' },
    { $project: { tag: { $toLower: '$hashtags' } } },
    { $match: { tag: { $regex: needle, $options: 'i' } } },
    { $group: { _id: '$tag', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: HASHTAG_SEARCH_LIMIT },
    { $project: { _id: 0, tag: '$_id', count: 1 } }
  ]);
}

function parseSearchQuery(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

// Public routes
// Get all hashtags
router.get("/", async (req: Request, res: Response) => {
  try {
  // default to 10 and enforce a maximum of 10 results from the backend
  const limit = Math.max(1, Math.min(parseInt((req.query.limit as string) || '10', 10), 10));
    const days = parseInt((req.query.days as string) || '7', 10);
    const since = isNaN(days) ? undefined : new Date(Date.now() - days * 24 * 60 * 60 * 1000);

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
        'content.text': { $exists: true, $ne: '' },
        createdAt: { $gte: fallbackSince },
      };
      const posts = await Post.find(textMatch)
        .select({ 'content.text': 1, createdAt: 1 })
        .sort({ createdAt: -1 })
        .limit(FALLBACK_SCAN_LIMIT)
        .lean();
      const counts: Record<string, { c: number; latest: Date }> = {};
      for (const p of posts) {
        const text: string = p?.content?.text || '';
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
// row can show "N posts" instead of a hardcoded zero.
router.get('/search', async (req: Request, res: Response) => {
  const query = parseSearchQuery(req.query.query);
  if (!query) {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'Search query is required'
    });
  }

  try {
    const hashtags = await searchHashtagsWithCounts(query);
    return res.json({ hashtags });
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
    const hashtags = await searchHashtagsWithCounts(query);
    return res.json({ data: hashtags.map((hashtag) => hashtag.tag) });
  } catch (error) {
    logger.error('[Hashtags] Error in searchHashtags:', { error, searchQuery: query });
    return res.status(500).json({
      error: 'Server error',
      message: 'Error searching hashtags'
    });
  }
});

export default router;
