import express, { Request, Response } from "express";
import Post from "../models/Post";

const router = express.Router();

// Public routes
// Get all hashtags
router.get("/", async (req: Request, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(parseInt((req.query.limit as string) || '10', 10), 50));
    const days = parseInt((req.query.days as string) || '7', 10);
    const since = isNaN(days) ? undefined : new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const match: any = {
      visibility: 'public',
      hashtags: { $exists: true, $ne: [] }
    };
    if (since) {
      match.createdAt = { $gte: since };
    }

    // Primary window aggregation (overall within optional `days`)
    let agg = await (Post as any).aggregate([
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

    const recentAgg = await (Post as any).aggregate([
      { $match: { visibility: 'public', hashtags: { $exists: true, $ne: [] }, createdAt: { $gte: recentStart } } },
      { $unwind: '$hashtags' },
      { $group: { _id: { $toLower: '$hashtags' }, c: { $sum: 1 } } }
    ]);
    const prevAgg = await (Post as any).aggregate([
      { $match: { visibility: 'public', hashtags: { $exists: true, $ne: [] }, createdAt: { $gte: prevStart, $lt: recentStart } } },
      { $unwind: '$hashtags' },
      { $group: { _id: { $toLower: '$hashtags' }, c: { $sum: 1 } } }
    ]);
    const recentMap = new Map<string, number>(recentAgg.map((x: any) => [x._id, x.c]));
    const prevMap = new Map<string, number>(prevAgg.map((x: any) => [x._id, x.c]));
    agg = agg.map((x: any) => {
      const id = (x.id || '').toLowerCase();
      const r = recentMap.get(id) || 0;
      const p = prevMap.get(id) || 0;
      let direction: 'up' | 'down' | 'flat' = 'flat';
      if (r > p) direction = 'up'; else if (p > r) direction = 'down';
      return { ...x, direction };
    });

    // Fallback: if no stored hashtags yet, derive from post content.text
    if (!agg || agg.length === 0) {
      const textMatch: any = {
        visibility: 'public',
        'content.text': { $exists: true, $ne: '' }
      };
      if (since) {
        textMatch.createdAt = { $gte: since };
      }
      const posts = await (Post as any).find(textMatch).select({ 'content.text': 1, createdAt: 1 }).lean();
      const counts: Record<string, { c: number; latest: Date }> = {};
      for (const p of posts) {
        const text: string = p?.content?.text || '';
        const matches = text.match(/#([A-Za-z0-9_]+)/g) || [];
        for (const raw of matches) {
          const tag = raw.replace(/^#/, '').toLowerCase();
          if (!counts[tag]) counts[tag] = { c: 0, latest: p.createdAt };
          counts[tag].c += 1;
          if (p.createdAt > counts[tag].latest) counts[tag].latest = p.createdAt;
        }
      }
      const fallbackArr = Object.entries(counts)
        .map(([id, v]) => ({ id, text: id, hashtag: `#${id}`, count: v.c, created_at: v.latest }))
        .sort((a, b) => (b.count - a.count) || ((b.created_at as any) - (a.created_at as any)))
        .slice(0, limit);
      // Compute simple direction for fallback (no previous window available): mark as 'up' if count > 0
      agg = fallbackArr.map((x: any) => ({ ...x, direction: x.count > 0 ? 'up' : 'flat' }));
    }

    res.json({ hashtags: agg });
  } catch (error) {
    console.error('Error fetching hashtags:', error);
    res.status(500).json({ message: "Error fetching hashtags from posts", error });
  }
});

// Search hashtags
router.post('/search', async (req: Request, res: Response) => {
  try {
    const { query } = req.body as { query?: string };

    if (!query || typeof query !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Search query is required'
      });
    }

    const match: any = {
      visibility: 'public',
      hashtags: { $exists: true, $ne: [] },
    };

    const agg = await (Post as any).aggregate([
      { $match: match },
      { $unwind: '$hashtags' },
      {
        $project: {
          tag: { $toLower: '$hashtags' }
        }
      },
      { $match: { tag: { $regex: query.toLowerCase(), $options: 'i' } } },
      { $group: { _id: '$tag', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $project: { _id: 0, tag: '$_id' } }
    ]);

    return res.json({ data: agg.map((x: any) => x.tag) });
  } catch (error: any) {
    console.error('Error in searchHashtags:', error);
    return res.status(500).json({
      error: 'Server error',
      message: `Error searching hashtags: ${error.message}`
    });
  }
});

export default router;
