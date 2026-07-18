import { Router, type Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import CustomFeed from '../models/CustomFeed';
import { FeedGenerator } from '../models/FeedGenerator';
import FeedReview from '../models/FeedReview';
import mongoose from 'mongoose';
import { validateBody, validateObjectId, schemas } from '../middleware/validate';
import { buildCustomFeedCreatePayload, buildCustomFeedUpdatePatch } from './customFeedWrite';
import { buildCustomFeedDefinition } from '../mtn/feed/definitions/customFeedDefinition';
import { loadViewerFeedContext } from '../mtn/feed/feedContext';
import { feedEngine } from '../mtn/feed/engine/FeedEngine';
import FeedLike from '../models/FeedLike';
import { escapeRegex } from '../utils/textProcessing';
import { resolveUserSummaries, degradedActorSummary } from '../services/PostHydrationService';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import type { CachedUserSummary } from '../services/userSummaryCache';
import type { PostUser } from '@mention/shared-types';
import { logger } from '../utils/logger';
import { queryInt, queryString } from '../utils/queryParams';

const router = Router();

/**
 * Upper bound on how many of the viewer's subscribed feeds are excluded from the
 * marketplace when `excludeSubscribed=true`. Bounds the `$nin` width so the query
 * stays predictable no matter how many feeds one account has liked.
 */
const MAX_EXCLUDED_SUBSCRIBED_FEEDS = 500;

/** Page size for the paginated custom-feed listings (marketplace, reviews, members). */
const DEFAULT_FEED_PAGE_SIZE = 20;
const MAX_FEED_PAGE_SIZE = 100;

/**
 * The public owner/member/reviewer profile this route embeds — the canonical Oxy
 * {@link PostUser} (Oxy owns identity, same shape as `post.user` / Who-to-follow).
 */
type UserProfile = PostUser;

/**
 * Map a resolved {@link CachedUserSummary} to the embedded Oxy {@link PostUser}.
 * Passthrough — Oxy owns the shape (`name.displayName`, `avatar` file id,
 * `username`). Falls back to the degraded user (EMPTY username, so the client
 * suppresses the handle instead of rendering the raw id — the ghost-handle rule).
 */
function profileFromSummary(oxyUserId: string, cached: CachedUserSummary | undefined): UserProfile {
  return cached?.user ?? degradedActorSummary(oxyUserId);
}

/**
 * Resolve many Oxy user ids to {@link UserProfile}s in ONE batched, Redis-backed
 * pass via {@link resolveUserSummaries} — the same resolver feed hydration and
 * starter-pack enrichment use. This collapses what was a per-id `oxy.getUserById`
 * HTTP fan-out (the classic N+1, served only by the SDK's separate 5-minute
 * in-process cache) into a single bulk service call for the cache misses, sharing
 * the one 10-minute `usersummary:v1:` cache. Best-effort: a whole-batch failure
 * resolves every id to its id-only fallback profile rather than failing the
 * response.
 */
async function resolveUserProfiles(oxyUserIds: string[]): Promise<Map<string, UserProfile>> {
  const result = new Map<string, UserProfile>();
  const uniqueIds = Array.from(new Set(oxyUserIds.filter((id): id is string => typeof id === 'string' && id.length > 0)));
  if (uniqueIds.length === 0) return result;

  let summaries = new Map<string, CachedUserSummary>();
  try {
    summaries = await resolveUserSummaries(uniqueIds);
  } catch (error) {
    logger.warn('[CustomFeeds] Failed to resolve user profiles', {
      count: uniqueIds.length,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }

  for (const id of uniqueIds) {
    result.set(id, profileFromSummary(id, summaries.get(id)));
  }
  return result;
}

// Create a new custom feed (composable definition)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    // Whitelist + validate the body into a persist-ready payload. The owner is set
    // from the session below — never from the body — and no field is spread from
    // `req.body` (no mass-assignment of subscriberCount / ratings / owner).
    const built = buildCustomFeedCreatePayload(req.body);
    if (!built.ok) return res.status(400).json({ error: built.error });

    const feed = await CustomFeed.create({ ownerOxyUserId: userId, ...built.payload });

    // Normalize _id to id for frontend consistency
    const normalizedFeed = {
      ...feed.toObject(),
      id: String(feed._id),
    };
    res.status(201).json(normalizedFeed);
  } catch (error) {
    logger.error('[CustomFeeds] Create custom feed error:', { userId: req.user?.id, error });
    res.status(500).json({ error: 'Failed to create feed' });
  }
});

// List feeds accessible to current user
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { mine, publicOnly, search } = req.query;
    // The owner filter is a Mongo query value, so it has to be a real string:
    // `?userId[$ne]=<viewer>` would otherwise reach the query as an operator.
    const queryUserId = queryString(req.query.userId);
    const q: Record<string, unknown> = {};

    if (queryUserId) {
      // Fetch feeds by a specific user — public only unless it's the current user
      q.ownerOxyUserId = queryUserId;
      if (!userId || queryUserId !== userId) {
        q.isPublic = true;
      }
    } else if (mine === 'true') {
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      q.ownerOxyUserId = userId;
    } else if (publicOnly === 'true') {
      q.isPublic = true;
    } else if (!userId) {
      q.isPublic = true;
    } else {
      // default: mine + public
      q.$or = [{ ownerOxyUserId: userId }, { isPublic: true }];
    }

    // Add search functionality
    if (search && typeof search === 'string' && search.trim()) {
      const searchTerm = escapeRegex(search.trim());
      const searchRegex = new RegExp(searchTerm, 'i');
      const searchCondition = {
        $or: [
          { title: searchRegex },
          { description: searchRegex },
          { keywords: searchRegex }
        ]
      };
      
      // Combine with existing query conditions
      if (q.$or) {
        // If there's already an $or (for mine/public), wrap both in $and
        q.$and = [{ $or: q.$or }, searchCondition];
        delete q.$or;
      } else {
        // If there's no $or, add search conditions directly
        q.$or = searchCondition.$or;
      }
    }

    // Opt-in pagination: with `?limit` present, page the results (offset/limit,
    // over-fetching one row to detect `hasMore`); without it, keep the historical
    // "return every accessible feed" behaviour the feeds screen / profile tabs
    // rely on. `_id` breaks `updatedAt` ties so offsets never shuffle rows.
    const rawLimit = queryInt(req.query.limit);
    const offset = Math.max(0, queryInt(req.query.offset) ?? 0);
    let listQuery = CustomFeed.find(q).sort({ updatedAt: -1, _id: -1 });
    let pageLimit: number | undefined;
    if (rawLimit !== undefined) {
      pageLimit = Math.min(Math.max(1, rawLimit), MAX_FEED_PAGE_SIZE);
      listQuery = listQuery.skip(offset).limit(pageLimit + 1);
    }
    const fetched = await listQuery.lean();
    const hasMore = pageLimit !== undefined && fetched.length > pageLimit;
    const items = hasMore ? fetched.slice(0, pageLimit) : fetched;

    // Get like counts and isLiked status for all feeds
    const feedIds = items.map((item) => item._id);
    const likeCountsMap = new Map<string, number>();
    const likedFeedsSet = new Set<string>();

    if (feedIds.length > 0) {
      // Get like counts for all feeds in one query (always fetch, even without userId)
      const likeCounts = await FeedLike.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
        { $match: { feedId: { $in: feedIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
        { $group: { _id: '$feedId', count: { $sum: 1 } } },
      ]);

      likeCounts.forEach((item) => {
        likeCountsMap.set(String(item._id), item.count);
      });

      // Get feeds liked by current user (only if userId exists)
      if (userId) {
        const userLikes = await FeedLike.find({ userId, feedId: { $in: feedIds.map((id) => new mongoose.Types.ObjectId(id)) } }).lean();
        userLikes.forEach((like) => {
          likedFeedsSet.add(String(like.feedId));
        });
      }
    }

    // Resolve owner profiles AND member avatars (first 3 per feed) in ONE batched,
    // Redis-backed pass over the union of all ids — no per-id HTTP fan-out.
    const ownerIds = items.map((item) => item.ownerOxyUserId).filter(Boolean) as string[];
    const allMemberIds = new Set<string>();
    items.forEach((item) => {
      (item.memberOxyUserIds || []).slice(0, 3).forEach((id) => allMemberIds.add(id));
    });

    const profilesById = await resolveUserProfiles([...ownerIds, ...allMemberIds]);
    const ownersMap = profilesById;
    const memberAvatarsMap = new Map<string, string | undefined>();
    for (const memberId of allMemberIds) {
      memberAvatarsMap.set(memberId, profilesById.get(memberId)?.avatar ?? undefined);
    }

    // Normalize _id to id for frontend consistency and add like data, owner info, and member avatars
    const normalizedItems = items.map((item) => {
      const feedId = String(item._id);
      const memberAvatars = (item.memberOxyUserIds || [])
        .slice(0, 3)
        .map((id) => memberAvatarsMap.get(id))
        .filter(Boolean);
      return {
        ...item,
        id: feedId,
        likeCount: likeCountsMap.get(feedId) || 0,
        isLiked: userId ? likedFeedsSet.has(feedId) : false,
        owner: item.ownerOxyUserId ? ownersMap.get(item.ownerOxyUserId) : undefined,
        memberAvatars,
        memberCount: (item.memberOxyUserIds || []).length,
        topicCount: (item.keywords || []).length,
      };
    });
    // When paging, `total` is the full match count (a countDocuments) so the
    // client can size the result set; unbounded, the page IS the whole set.
    const total = pageLimit !== undefined ? await CustomFeed.countDocuments(q) : normalizedItems.length;
    res.json({
      items: normalizedItems,
      total,
      pagination: { offset, limit: pageLimit ?? normalizedItems.length, hasMore },
    });
  } catch (error) {
    logger.error('[CustomFeeds] List custom feeds error:', { userId: req.user?.id, error, query: req.query });
    res.status(500).json({ error: 'Failed to list feeds' });
  }
});

// Marketplace: get feeds by category counts
router.get('/marketplace/categories', async (req: AuthRequest, res: Response) => {
  try {
    const results = await CustomFeed.aggregate<{ _id: string; count: number }>([
      { $match: { isPublic: true, category: { $exists: true, $ne: null } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    const categories = results.map((r) => ({ category: r._id, count: r.count }));
    res.json({ categories });
  } catch (error) {
    logger.error('[CustomFeeds] Marketplace categories error:', { error });
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

// Marketplace: browse public feeds with filtering, search, and sorting
router.get('/marketplace', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { category, search, sortBy = 'trending' } = req.query;

    const page = Math.max(1, queryInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, queryInt(req.query.limit) || DEFAULT_FEED_PAGE_SIZE), MAX_FEED_PAGE_SIZE);
    const skip = (page - 1) * limit;

    const q: Record<string, unknown> = { isPublic: true };

    // `excludeSubscribed=true` — recommendation surfaces (the feed interstitial)
    // must never suggest a feed the viewer already has. "Subscribed" is a
    // `FeedLike` (the mechanism that maintains `CustomFeed.subscriberCount`), so
    // the viewer's own feeds and their liked feeds drop out of the page AND out
    // of `total`. Ignored for anonymous viewers — they subscribe to nothing.
    if (userId && String(req.query.excludeSubscribed) === 'true') {
      const likes = await FeedLike.find({ userId }, { feedId: 1, _id: 0 })
        .limit(MAX_EXCLUDED_SUBSCRIBED_FEEDS)
        .lean();
      q.ownerOxyUserId = { $ne: userId };
      if (likes.length > 0) {
        q._id = { $nin: likes.map((like) => like.feedId) };
      }
    }

    if (category && typeof category === 'string') {
      q.category = category;
    }

    if (search && typeof search === 'string' && search.trim()) {
      const searchTerm = escapeRegex(search.trim());
      const searchRegex = new RegExp(searchTerm, 'i');
      q.$or = [
        { title: searchRegex },
        { description: searchRegex },
        { tags: searchRegex },
        { keywords: searchRegex },
      ];
    }

    let sortStage: Record<string, 1 | -1>;
    if (sortBy === 'rating' || sortBy === 'top_rated') {
      sortStage = { averageRating: -1, ratingsCount: -1, createdAt: -1 };
    } else if (sortBy === 'newest') {
      sortStage = { createdAt: -1 };
    } else {
      // trending (default): sort by subscriberCount desc
      sortStage = { subscriberCount: -1, createdAt: -1 };
    }

    const [items, total] = await Promise.all([
      CustomFeed.find(q).sort(sortStage).skip(skip).limit(limit).lean(),
      CustomFeed.countDocuments(q),
    ]);

    // Resolve isLiked + owner profiles in parallel (subscriberCount already on feed docs)
    const feedIds = items.map((item) => item._id);
    const likedFeedsSet = new Set<string>();
    const ownerIds = items.map((item) => item.ownerOxyUserId).filter(Boolean) as string[];
    let ownersMap = new Map<string, UserProfile>();

    await Promise.all([
      // User's liked feeds
      userId && feedIds.length > 0
        ? FeedLike.find({ userId, feedId: { $in: feedIds.map((id) => new mongoose.Types.ObjectId(id)) } }).lean()
            .then((likes) => likes.forEach((like) => likedFeedsSet.add(String(like.feedId))))
        : Promise.resolve(),
      // Owner profiles — one batched, Redis-backed resolution for all owners
      resolveUserProfiles(ownerIds).then((map) => { ownersMap = map; }),
    ]);

    const normalizedItems = items.map((item) => {
      const feedId = String(item._id);
      return {
        ...item,
        id: feedId,
        likeCount: item.subscriberCount || 0,
        isLiked: userId ? likedFeedsSet.has(feedId) : false,
        owner: item.ownerOxyUserId ? ownersMap.get(item.ownerOxyUserId) : undefined,
        memberCount: (item.memberOxyUserIds || []).length,
        topicCount: (item.keywords || []).length,
      };
    });

    res.json({
      items: normalizedItems,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    logger.error('[CustomFeeds] Marketplace list error:', { error, query: req.query });
    res.status(500).json({ error: 'Failed to load marketplace' });
  }
});

/**
 * List a user's FEED GENERATORS — third-party/algorithmic feeds keyed on `createdBy`.
 *
 * Today these are Bluesky feed generators mirrored into native `FeedGenerator` rows
 * (`source.network === 'atproto'`). Each is served by the feed engine via the
 * `feedgen|<uri>` descriptor returned as `descriptor` — opening one imports the
 * remote algorithm's output as NATIVE posts. This is the per-owner "native feeds
 * list keyed on createdBy" that surfaces a federated profile's synced Bluesky feeds
 * on its Feeds tab, alongside the account's native custom feeds. They are read-only
 * (owned upstream — the `source` subdoc marks them federated), so there is no write
 * route to guard here. Declared BEFORE `/:id` so `generators` never matches the
 * ObjectId param route.
 */
router.get('/generators', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const queryUserId = queryString(req.query.userId);
    const ownerId = queryUserId || (String(req.query.mine) === 'true' ? userId : undefined);
    if (!ownerId) {
      return res.status(400).json({ error: 'A userId or mine=true is required' });
    }

    const items = await FeedGenerator.find({ createdBy: ownerId, 'source.network': 'atproto' })
      .sort({ likeCount: -1, updatedAt: -1 })
      .limit(MAX_FEED_PAGE_SIZE)
      .lean();

    const owner = (await resolveUserProfiles([ownerId])).get(ownerId);

    const normalizedItems = items.map((item) => ({
      id: String(item._id),
      uri: item.uri,
      descriptor: `feedgen|${item.uri}`,
      title: item.name,
      description: item.description,
      avatar: item.avatar,
      likeCount: item.likeCount || 0,
      owner,
    }));

    res.json({ items: normalizedItems, total: normalizedItems.length });
  } catch (error) {
    logger.error('[CustomFeeds] List feed generators error:', { userId: req.user?.id, error, query: req.query });
    res.status(500).json({ error: 'Failed to list feed generators' });
  }
});

// Get a feed by id
router.get('/:id', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const feed = await CustomFeed.findById(req.params.id).lean();
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (!feed.isPublic && feed.ownerOxyUserId !== userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    
    const feedId = String(feed._id);
    
    // Get like count
    const likeCount = await FeedLike.countDocuments({ feedId: new mongoose.Types.ObjectId(feedId) });
    
    // Get isLiked status for current user
    let isLiked = false;
    if (userId) {
      const userLike = await FeedLike.findOne({ userId, feedId: new mongoose.Types.ObjectId(feedId) });
      isLiked = !!userLike;
    }
    
    // Resolve owner + member profiles in ONE batched, Redis-backed pass.
    const memberIds = (feed.memberOxyUserIds || []).slice(0, 50) as string[];
    const profilesById = await resolveUserProfiles(
      feed.ownerOxyUserId ? [feed.ownerOxyUserId, ...memberIds] : memberIds,
    );

    const owner = feed.ownerOxyUserId ? profilesById.get(feed.ownerOxyUserId) ?? null : null;
    // Preserve member ORDER (the map is keyed by id; rebuild the ordered list).
    const members = memberIds.map((mid) => profilesById.get(mid) ?? profileFromSummary(mid, undefined));

    const memberAvatars = members.slice(0, 4).map(m => m.avatar).filter(Boolean);

    // Normalize _id to id for frontend consistency
    const normalizedFeed = {
      ...feed,
      id: feedId,
      likeCount,
      isLiked,
      owner,
      members,
      memberAvatars,
      memberCount: (feed.memberOxyUserIds || []).length,
      topicCount: (feed.keywords || []).length,
    };
    res.json(normalizedFeed);
  } catch (error) {
    logger.error('[CustomFeeds] Get feed error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

// Update a feed (owner only)
router.put('/:id', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const feed = await CustomFeed.findById(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (feed.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });

    // Whitelist + validate; only the returned patch keys are applied (no spread of
    // req.body, so owner/aggregate fields can never be reassigned).
    const built = buildCustomFeedUpdatePatch(req.body);
    if (!built.ok) return res.status(400).json({ error: built.error });

    if (built.payload.title !== undefined) feed.title = built.payload.title;
    if (built.payload.description !== undefined) feed.description = built.payload.description;
    if (built.payload.isPublic !== undefined) feed.isPublic = built.payload.isPublic;
    if (built.payload.icon !== undefined) feed.icon = built.payload.icon;
    if (built.payload.definition !== undefined) feed.definition = built.payload.definition;
    await feed.save();

    // Normalize _id to id for frontend consistency
    const normalizedFeed = {
      ...feed.toObject(),
      id: String(feed._id),
    };
    res.json(normalizedFeed);
  } catch (error) {
    logger.error('[CustomFeeds] Update custom feed error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to update feed' });
  }
});

// Delete a feed (owner only)
router.delete('/:id', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const feed = await CustomFeed.findById(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (feed.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    await feed.deleteOne();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete feed' });
  }
});

// Add members (owner only)
router.post('/:id/members', validateObjectId('id'), validateBody(schemas.manageFeedMembers), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { userIds } = req.body || {};
    const feed = await CustomFeed.findById(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (feed.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    const toAdd: string[] = Array.isArray(userIds) ? userIds : [];
    const set = new Set([...(feed.memberOxyUserIds || []), ...toAdd]);
    feed.memberOxyUserIds = Array.from(set);
    await feed.save();
    // Normalize _id to id for frontend consistency
    const normalizedFeed = {
      ...feed.toObject(),
      id: String(feed._id),
    };
    res.json(normalizedFeed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// Remove members (owner only)
router.delete('/:id/members', validateObjectId('id'), validateBody(schemas.manageFeedMembers), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { userIds } = req.body || {};
    const feed = await CustomFeed.findById(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (feed.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    const toRemove: Set<string> = new Set(Array.isArray(userIds) ? userIds : []);
    feed.memberOxyUserIds = (feed.memberOxyUserIds || []).filter(id => !toRemove.has(id));
    await feed.save();
    // Normalize _id to id for frontend consistency
    const normalizedFeed = {
      ...feed.toObject(),
      id: String(feed._id),
    };
    res.json(normalizedFeed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove members' });
  }
});

// Timeline for a custom feed — runs the stored composable definition through the
// FeedEngine (the same engine that serves every descriptor feed).
router.get('/:id/timeline', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const limit = Math.min(Math.max(queryInt(req.query.limit) || DEFAULT_FEED_PAGE_SIZE, 1), MAX_FEED_PAGE_SIZE);
    const cursor = queryString(req.query.cursor)?.trim();

    const feed = await CustomFeed.findById(req.params.id).lean();
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (!feed.isPublic && feed.ownerOxyUserId !== userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    // Resolve the runnable definition (stored, or derived from legacy fields for
    // feeds not yet backfilled) and run it against the viewer's feed context.
    const definition = buildCustomFeedDefinition(feed);
    const context = await loadViewerFeedContext(userId, getServiceOxyClient());
    const response = await feedEngine.run(definition, context, { cursor, limit });

    // The frontend Feed component expects `items` to be posts directly.
    res.json({
      items: response.items,
      hasMore: response.hasMore,
      nextCursor: response.nextCursor,
      totalCount: response.totalCount,
    });
  } catch (error) {
    logger.error('[CustomFeeds] Custom feed timeline error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to load timeline' });
  }
});

// Like a feed
router.post('/:id/like', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const feedId = String(req.params.id);
    const feed = await CustomFeed.findById(feedId);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    // Try to create like record — unique index prevents duplicates
    try {
      await FeedLike.create({ userId, feedId });
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 11000) {
        // Already liked — return current subscriberCount
        const f = await CustomFeed.findById(feedId, { subscriberCount: 1 }).lean();
        return res.json({
          success: true,
          liked: true,
          likeCount: f?.subscriberCount ?? 0,
          message: 'Feed already liked',
        });
      }
      throw err;
    }

    // Atomically increment subscriberCount
    const updated = await CustomFeed.findByIdAndUpdate(
      feedId,
      { $inc: { subscriberCount: 1 } },
      { new: true, projection: { subscriberCount: 1 } }
    );

    res.json({
      success: true,
      liked: true,
      likeCount: updated?.subscriberCount ?? 0,
      message: 'Feed liked successfully',
    });
  } catch (error) {
    logger.error('[CustomFeeds] Like feed error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to like feed' });
  }
});

// Unlike a feed
router.delete('/:id/like', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const feedId = String(req.params.id);
    const feed = await CustomFeed.findById(feedId);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    // Remove like record
    const result = await FeedLike.deleteOne({ userId, feedId });

    if (result.deletedCount === 0) {
      const f = await CustomFeed.findById(feedId, { subscriberCount: 1 }).lean();
      return res.json({
        success: true,
        liked: false,
        likeCount: f?.subscriberCount ?? 0,
        message: 'Feed not liked',
      });
    }

    // Atomically decrement subscriberCount
    const updated = await CustomFeed.findByIdAndUpdate(
      feedId,
      { $inc: { subscriberCount: -1 } },
      { new: true, projection: { subscriberCount: 1 } }
    );

    res.json({
      success: true,
      liked: false,
      likeCount: Math.max(0, updated?.subscriberCount ?? 0),
      message: 'Feed unliked successfully',
    });
  } catch (error) {
    logger.error('[CustomFeeds] Unlike feed error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to unlike feed' });
  }
});

// Get reviews for a feed
router.get('/:id/reviews', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, queryInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, queryInt(req.query.limit) || DEFAULT_FEED_PAGE_SIZE), MAX_FEED_PAGE_SIZE);
    const skip = (page - 1) * limit;

    const feedId = new mongoose.Types.ObjectId(String(req.params.id));

    const [reviews, total] = await Promise.all([
      FeedReview.find({ feedId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      FeedReview.countDocuments({ feedId }),
    ]);

    // Resolve reviewer profiles
    const reviewerIds = reviews.map((r) => r.reviewerId).filter(Boolean) as string[];
    const reviewersMap = await resolveUserProfiles(reviewerIds);

    const normalizedReviews = reviews.map((r) => ({
      ...r,
      id: String(r._id),
      reviewer: reviewersMap.get(r.reviewerId) || profileFromSummary(r.reviewerId, undefined),
    }));

    res.json({
      reviews: normalizedReviews,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    logger.error('[CustomFeeds] Get reviews error:', { feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// Create or update a review for a feed
router.post('/:id/reviews', validateObjectId('id'), validateBody(schemas.createFeedReview), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const feedId = new mongoose.Types.ObjectId(String(req.params.id));
    const feed = await CustomFeed.findById(feedId);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    const { rating, reviewText } = req.body;

    // Upsert: update existing review or insert new one
    const review = await FeedReview.findOneAndUpdate(
      { feedId, reviewerId: userId },
      { rating, reviewText: reviewText || undefined },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Recalculate averageRating and ratingsCount from all reviews for this feed
    const ratingStats = await FeedReview.aggregate([
      { $match: { feedId } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);

    if (ratingStats.length > 0) {
      const { avg, count } = ratingStats[0];
      await CustomFeed.updateOne(
        { _id: feedId },
        { averageRating: Math.round(avg * 10) / 10, ratingsCount: count }
      );
    }

    res.json({
      ...review.toObject(),
      id: String(review._id),
    });
  } catch (error) {
    logger.error('[CustomFeeds] Create/update review error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

export default router;
