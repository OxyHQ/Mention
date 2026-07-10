import { Response } from 'express';
import type { ParsedQs } from 'qs';
import { Post, POST_CLASSIFICATION_PENDING } from '../models/Post';
import Poll from '../models/Poll';
import Like, { ILike } from '../models/Like';
import Bookmark from '../models/Bookmark';
import Block from '../models/Block';
import Mute from '../models/Mute';
import {
  CreateReplyRequest,
  CreateBoostRequest,
  LikeRequest,
  UnlikeRequest,
  FeedType,
  PostType,
  PostVisibility,
  PostContent,
  HydratedPost,
} from '@mention/shared-types';
import mongoose, { FilterQuery } from 'mongoose';
import { IPost } from '../models/Post';
import { IAccountList } from '../models/AccountList';
import { io } from '../../server';
import { oxy as oxyClient } from '../../server';
import { userPreferenceService, readInteractionSurface } from '../services/UserPreferenceService';
import { affinityEventService } from '../services/AffinityEventService';
import { postHydrationService } from '../services/PostHydrationService';
import UserSettings from '../models/UserSettings';
import { checkFollowAccess, extractFollowingIds, requiresAccessCheck, ProfileVisibility, OxyClient } from '../utils/privacyHelpers';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { logger } from '../utils/logger';
import { FeedQueryBuilder } from '../utils/feedQueryBuilder';
import { FeedResponseBuilder } from '../utils/FeedResponseBuilder';
import { ChronoCursor } from '../mtn/feed/CursorBuilder';
import {
  validateAndNormalizeLimit,
  parseFeedFilters,
  parseFeedCursor,
  validateResultSize,
  fetchWithRecencyFallback,
  FEED_CONSTANTS
} from '../utils/feedUtils';
import { anonFeedCache } from '../services/anonFeedCache';
import { metrics } from '../utils/metrics';
import { config } from '../config';
import { mergeHashtags } from '../utils/textProcessing';
import { buildAuthorship } from '../utils/postAuthorship';
import { validatePublicShareTarget } from '../utils/postAccessControl';
import { baselineContentClassifier } from '../services/BaselineContentClassifier';
import { createScopedOxyClient, getServiceOxyClient } from '../utils/oxyHelpers';
import {
  emitPostCreated,
  emitRepostCreated,
  emitLikeCreated,
  emitBookmarkCreated,
  emitTombstone,
  likeRecordUri,
  repostRecordUri,
  bookmarkRecordUri,
} from '../services/mtn/MentionRecordEmitter';
import type { User } from '@oxyhq/core';
import { threadSlicingService } from '../services/ThreadSlicingService';
import FederatedActor, { IFederatedActor } from '../models/FederatedActor';
import { activityPubConnector, isPermanentlyUnavailableOutboxReason } from '../connectors/activitypub/ActivityPubConnector';
import { FEDERATION_ENABLED } from '../connectors/activitypub/constants';
import { ATPROTO_ENABLED } from '../connectors/atproto/constants';
import { connectorRegistry } from '../connectors';
import {
  isWithinOutboxSyncCooldown,
  shouldForceUntrackedOutboxSync,
} from '../connectors/activitypub/outboxSyncCooldown';
import { sanitizePodcast, resolvePodcastContent } from '../utils/syraPodcast';

/**
 * Minimum interval between background outbox re-syncs for the same federated
 * actor. Profile views trigger a background outbox sync; without a cooldown
 * every view re-fetches and re-dedupes the entire outbox. Mirrors the
 * ACTOR_REFRESH_MIN_INTERVAL_MS guard used for full-actor refreshes.
 */
const OUTBOX_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Cached federated actors older than this are refreshed before a profile outbox
 * sync. Profile sync runs off the request path, so it can afford to fetch the
 * actor document first and use the advertised outbox instead of stale guesses.
 */
const FEDERATED_ACTOR_PROFILE_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Hard cap on how many posts of an author's self-thread continuation spine the
 * post-detail thread view returns. Threads are short in practice (a handful of
 * continuations); this is a safety ceiling mirroring the frontend ancestor walk
 * guard (MAX_ANCESTOR_DEPTH), guarding against a runaway thread.
 */
const MAX_THREAD_CONTINUATION_DEPTH = 50;

/**
 * A follower/mention reference may arrive as a bare user-id string or as a
 * populated object carrying `id`/`_id`. Used when checking reply permissions.
 */
type FollowerRef = string | { id?: string; _id?: string };

/**
 * Express parses query values as `string | string[] | ParsedQs | ParsedQs[]`.
 * Returns the value only when it is a plain string, otherwise `undefined`, so
 * callers reading a single scalar param stay type-safe without an `any` cast.
 */
function coerceQueryString(value: ParsedQs[string]): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Display-ready poll data attached to a post's content for the client. */
interface PopulatedPollData {
  question: string;
  options: string[];
  endTime: string;
  votes: Record<number, number>;
  userVotes: Record<string, string>;
}

/**
 * Minimal lean-post shape touched by {@link FeedController.populatePollData}: it
 * reads `content.pollId` and writes the resolved `content.poll` back in place.
 */
interface PollBearingPost {
  content?: {
    pollId?: string;
    poll?: PopulatedPollData;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Feed Controller
 * 
 * Handles all feed-related endpoints with enterprise-grade optimizations:
 * - Optimized database queries with field selection
 * - Cursor-based pagination for scalability
 * - Advanced ranking algorithms for personalized feeds
 * - Comprehensive error handling and performance monitoring
 * 
 * @class FeedController
 */
class FeedController {
  // Note: checkFollowAccess is now imported from privacyHelpers

  // ============================================================================
  // Constants - Enterprise Configuration
  // ============================================================================
  
  /** Optimized field selection for feed queries - reduces data transfer by 60-80% */
  private readonly FEED_FIELDS = '_id oxyUserId federation createdAt visibility type parentPostId boostOf quoteOf threadId content stats metadata hashtags mentions language';

  /** Slow query threshold in milliseconds (logs warnings for queries exceeding this) */
  private readonly SLOW_QUERY_THRESHOLD_MS = config.feed.slowQueryThresholdMs;

  /**
   * Max number of recent outbox posts to pull per background federated sync.
   */
  private readonly FED_OUTBOX_SYNC_LIMIT = 20;

  /**
   * Transform posts to include full profile data and engagement stats
   * 
   * @param posts - Raw post documents from database
   * @param currentUserId - Current user ID for personalization
   * @returns Array of hydrated posts with user data and engagement stats
   */
  // Public because the list-timeline route (`routes/lists.ts`) reuses the same
  // hydration path as the controller's own feed endpoints.
  async transformPostsWithProfiles(posts: object[], currentUserId?: string, oxyClient?: OxyClient): Promise<HydratedPost[]> {
    try {
      if (!posts || posts.length === 0) {
        return [];
      }

      // Optimized hydration for feed items: maxDepth 0 (no nested posts) for better performance
      // Feed items don't need nested context - only detail views need depth 1
      const hydrated = await postHydrationService.hydratePosts(posts, {
        viewerId: currentUserId,
        oxyClient,
        maxDepth: 0, // Reduced from 1 for feed performance - saves ~30-50ms per request
        includeLinkMetadata: true,
        includeFullArticleBody: false, // Don't include article bodies in feed
        includeFullMetadata: false, // Skip some metadata fields for performance
      });
      
      // Ensure all posts have required fields
      return hydrated.filter((post) => {
        if (!post || !post.id) {
          logger.warn('[Feed] Filtered out post without id', post);
          return false;
        }
        if (!post.user || !post.user.id) {
          logger.warn('[Feed] Filtered out post without user', post.id);
          return false;
        }
        return true;
      });
    } catch (error) {
      logger.error('[Feed] Error transforming posts', error);
      // Return empty array instead of throwing to prevent feed from breaking
      return [];
    }
  }

  /**
   * Get list of blocked and muted user IDs for filtering
   *
   * @param userId - Current user ID
   * @returns Array of user IDs to filter out
   */
  private async getBlockedAndMutedUserIds(userId?: string): Promise<string[]> {
    if (!userId) return [];

    try {
      const [blockedUsers, mutedUsers] = await Promise.all([
        Block.find({ userId }).select('blockedId').lean(),
        Mute.find({ userId }).select('mutedId').lean()
      ]);

      const blockedIds = blockedUsers.map(b => b.blockedId);
      const mutedIds = mutedUsers.map(m => m.mutedId);

      // Combine and deduplicate
      return [...new Set([...blockedIds, ...mutedIds])];
    } catch (error) {
      logger.warn('[Feed] Failed to fetch blocked/muted users', error);
      return [];
    }
  }

  /**
   * Filter out posts from blocked and muted users
   *
   * @param posts - Array of posts to filter
   * @param blockedAndMutedIds - Array of user IDs to filter out
   * @returns Filtered posts array
   */
  private filterBlockedAndMutedPosts<T extends { oxyUserId?: unknown }>(posts: T[], blockedAndMutedIds: string[]): T[] {
    if (blockedAndMutedIds.length === 0) return posts;

    return posts.filter(post => {
      const authorId = post.oxyUserId == null ? '' : String(post.oxyUserId);
      return !blockedAndMutedIds.includes(authorId);
    });
  }

  /**
   * Populate poll data for posts that have polls
   *
   * @param posts - Array of posts that may contain poll references
   * @returns Posts with poll data populated
   */
  async populatePollData(posts: unknown[]): Promise<unknown[]> {
    try {
      // Posts are lean documents; narrow to the poll-bearing shape we read/write.
      const pollPosts = posts as Array<PollBearingPost>;

      // Get all poll IDs from posts
      const pollIds = pollPosts
        .map((post) => post?.content?.pollId)
        .filter((id): id is string => Boolean(id));

      if (pollIds.length === 0) {
        return posts;
      }

      // Fetch all polls in one query
      const polls = await Poll.find({ _id: { $in: pollIds } }).lean();

      // Create a map for quick lookup
      const pollMap = new Map<string, PopulatedPollData>();
      polls.forEach(poll => {
        pollMap.set(poll._id.toString(), {
          question: poll.question,
          options: poll.options.map((option) => option.text),
          endTime: poll.endsAt.toISOString(),
          votes: poll.options.reduce<Record<number, number>>((acc, option, index) => {
            acc[index] = option.votes.length;
            return acc;
          }, {}),
          userVotes: poll.options.reduce<Record<string, string>>((acc, option) => {
            option.votes.forEach((userId: string) => {
              acc[userId] = String(poll.options.indexOf(option));
            });
            return acc;
          }, {})
        });
      });

      // Add poll data to posts
      pollPosts.forEach((post) => {
        const pollId = post?.content?.pollId;
        if (pollId) {
          const pollData = pollMap.get(pollId);
          if (pollData && post.content) {
            post.content.poll = pollData;
          }
        }
      });
      return posts;
    } catch (error) {
      logger.error('Error populating poll data', error);
      return posts; // Return posts without poll data if population fails
    }
  }

  /**
   * Get main feed with pagination and real-time updates
   */
  async getFeed(req: AuthRequest, res: Response) {
    const startTime = Date.now();
    try {
      // Input validation and sanitization - Enterprise-grade
      const { type = 'mixed', cursor, sort } = req.query as { type?: FeedType; cursor?: string; sort?: string };

      // Validate feed type (prevent injection and invalid types)
      const validFeedTypes: FeedType[] = ['mixed', 'posts', 'media', 'replies', 'boosts', 'saved', 'for_you', 'following', 'explore'];
      const feedType: FeedType = validFeedTypes.includes(type as FeedType) ? (type as FeedType) : 'mixed';

      // Validate sort parameter
      const validSorts = ['recent', 'best', 'oldest'];
      const feedSort = validSorts.includes(sort as string) ? sort as string : undefined;

      // Parse and validate limit parameter using utility
      const limit = validateAndNormalizeLimit(req.query.limit, FEED_CONSTANTS.DEFAULT_LIMIT);

      // Parse filters using utility
      const feedFilters = parseFeedFilters(req.query);
      const currentUserId = req.user?.id;
      
      // Debug logging for saved posts
      if (feedType === 'saved') {
        logger.debug('[Saved Feed] Raw query params', JSON.stringify(req.query, null, 2));
        logger.debug('[Saved Feed] Parsed filters', JSON.stringify(feedFilters, null, 2));
      }

      // Handle customFeedId filter - expand to custom feed configuration
      let filters = feedFilters;
      try {
        if (filters && filters.customFeedId) {
          const { CustomFeed } = require('../models/CustomFeed.js');
          // Validate ObjectId format to prevent injection
          const feedId = String(filters.customFeedId);
          if (!mongoose.Types.ObjectId.isValid(feedId)) {
            return res.status(400).json({ error: 'Invalid feed ID format' });
          }
          const feed = await CustomFeed.findById(feedId).lean();
          if (feed) {
            // Check access permissions
            if (!feed.isPublic && feed.ownerOxyUserId !== currentUserId) {
              return res.status(403).json({ error: 'Feed not accessible' });
            }

            // Expand authors from direct members + lists
            let authors: string[] = Array.from(new Set(feed.memberOxyUserIds || []));
            try {
              if (feed.sourceListIds && feed.sourceListIds.length) {
                const { AccountList } = require('../models/AccountList.js');
                const lists: Array<Pick<IAccountList, 'memberOxyUserIds'>> = await AccountList.find({ _id: { $in: feed.sourceListIds } }).lean();
                lists.forEach((l) => (l.memberOxyUserIds || []).forEach((id: string) => authors.push(id)));
                authors = Array.from(new Set(authors));
              }
            } catch (e) {
              logger.warn('Failed to expand feed.sourceListIds', (e as Error)?.message || e);
            }

            // Exclude owner unless they're in the member list
            const ownerId = feed.ownerOxyUserId;
            const ownerIsInMembers = authors.includes(ownerId);
            if (!ownerIsInMembers && ownerId) {
              authors = authors.filter(id => id !== ownerId);
            }

            // Build filters from custom feed configuration
            filters = {
              ...(filters || {}),
              authors: authors.length > 0 ? authors.join(',') : undefined,
              keywords: feed.keywords && feed.keywords.length > 0 ? feed.keywords.join(',') : undefined,
              includeReplies: feed.includeReplies,
              includeBoosts: feed.includeBoosts,
              includeMedia: feed.includeMedia,
              language: feed.language,
              excludeOwner: !ownerIsInMembers // Exclude owner if not in members
            };

          } else {
            return res.status(404).json({ error: 'Custom feed not found' });
          }
        }
      } catch (e) {
        logger.warn('Optional customFeedId expansion failed', (e as Error)?.message || e);
      }

      // If a listId or listIds is provided, expand to authors
      try {
        if (filters && (filters.listId || filters.listIds)) {
          const { AccountList } = require('../models/AccountList.js');
          const ids = String(filters.listIds || filters.listId)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          if (ids.length) {
            const lists: Array<Pick<IAccountList, 'memberOxyUserIds'>> = await AccountList.find({ _id: { $in: ids } }).lean();
            const authors = new Set(
              String(filters.authors || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            );
            lists.forEach((l) => (l.memberOxyUserIds || []).forEach((id: string) => authors.add(id)));
            filters = { ...(filters || {}), authors: Array.from(authors).join(',') };
          }
        }
      } catch (e) {
        logger.warn('Optional listIds expansion failed', (e as Error)?.message || e);
      }

      // Handle saved posts type
      let savedPostIds: mongoose.Types.ObjectId[] = [];
      if (feedType === 'saved') {
        if (!currentUserId) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        // Get saved post IDs for the user
        const savedPosts = await Bookmark.find({ userId: currentUserId })
          .sort({ createdAt: -1 })
          .lean();
        savedPostIds = savedPosts.map(saved => {
          try {
            return saved.postId instanceof mongoose.Types.ObjectId 
              ? saved.postId 
              : new mongoose.Types.ObjectId(saved.postId);
          } catch (e) {
            logger.error('Invalid postId in bookmark', { postId: saved.postId, error: e });
            return null;
          }
        }).filter((id): id is mongoose.Types.ObjectId => id !== null);
        
        logger.debug(`[Saved Feed] Found ${savedPostIds.length} saved posts for user ${currentUserId}`);
        
        if (savedPostIds.length === 0) {
          return res.json({
            items: [],
            hasMore: false,
            nextCursor: undefined,
            totalCount: 0
          });
        }
      }

      // Anonymous feeds are identical for every logged-out viewer (no per-user
      // blocked/muted filtering, no seen-set), so the fully built page is cached
      // in Redis for a short window. This collapses a burst of anon requests
      // into a single engagement-sort + hydration recompute. Fail-soft: a cache
      // miss/error falls straight through to a live build. Authenticated feeds
      // are personalized and never cached here.
      const anonCacheKey = !currentUserId
        ? anonFeedCache.buildKey({ type: feedType, sort: feedSort, limit, cursor, filters })
        : undefined;
      if (anonCacheKey) {
        const cachedResponse = await anonFeedCache.read(anonCacheKey);
        if (cachedResponse) {
          return res.json(cachedResponse);
        }
      }

      // Build query
      let query: FilterQuery<IPost>;
      if (feedType === 'saved' && savedPostIds.length > 0) {
        // For saved posts, use a simple query that only filters by saved post IDs
        // Don't filter by visibility - users should be able to see their saved posts regardless of visibility
        query = {
          _id: { $in: savedPostIds }
        };
        
        // Apply search query filter if provided
        if (filters?.searchQuery) {
          const searchQuery = String(feedFilters.searchQuery).trim();
          logger.debug(`[Saved Feed] Applying search filter: "${searchQuery}"`);
          if (searchQuery) {
            // Use MongoDB $regex for partial text matching (case-insensitive)
            // Escape special regex characters but allow partial matching
            const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query['content.text'] = {
              $regex: escapedQuery,
              $options: 'i' // case-insensitive
            };
          }
        }
        
        logger.debug(`[Saved Feed] Final query`, JSON.stringify(query, null, 2));
      } else {
        query = FeedQueryBuilder.buildQuery({ type: feedType, filters: feedFilters, currentUserId, limit: FEED_CONSTANTS.DEFAULT_LIMIT });
      }

      // Add cursor-based pagination (handle conflict with saved posts _id filter)
      if (cursor) {
        if (feedType === 'saved' && savedPostIds.length > 0) {
          // For saved posts with cursor, filter savedPostIds to only include those before cursor
          const cursorId = parseFeedCursor(cursor);
          if (!cursorId) {
            return res.json(FeedResponseBuilder.buildEmptyResponse());
          }
          const filteredSavedIds = savedPostIds.filter(id => id < cursorId);
          if (filteredSavedIds.length === 0) {
            return res.json({
              items: [],
              hasMore: false,
              nextCursor: undefined,
              totalCount: 0
            });
          }
          // Preserve search query and other filters if they exist
          const searchQuery = query['content.text'];
          query = {
            _id: { $in: filteredSavedIds }
          };
          if (searchQuery) {
            query['content.text'] = searchQuery;
          }
        } else {
          const cursorId = parseFeedCursor(cursor);
          if (cursorId) {
            query._id = { $lt: cursorId };
          }
        }
      }

      // For unauthenticated users, return popular posts sorted by engagement
      // For authenticated users, use the personalized algorithm
      let posts;
      if (!currentUserId) {
        // Sort by engagement score (popular posts) for unauthenticated users.
        // A recency window bounds the scan through the
        // `{ visibility, status, createdAt }` index instead of sorting the whole
        // collection; the never-blank fallback (7d → 30d → unbounded) guarantees
        // a sparse instance still fills the page. When the caller already set an
        // explicit `createdAt` range (date filters), that range bounds the scan
        // and the window is skipped so the filter is respected exactly.
        const runAnonPopular = (cutoff: Date | undefined) =>
          Post.aggregate([
            { $match: cutoff ? { ...query, createdAt: { $gte: cutoff } } : query },
            {
              $project: {
                _id: 1,
                oxyUserId: 1,
                createdAt: 1,
                visibility: 1,
                type: 1,
                parentPostId: 1,
                boostOf: 1,
                quoteOf: 1,
                threadId: 1,
                content: 1,
                stats: 1,
                metadata: 1,
                hashtags: 1,
                mentions: 1,
                language: 1
              }
            },
            {
              $addFields: {
                engagementScore: {
                  $add: [
                    { $ifNull: ['$stats.likesCount', 0] },
                    { $multiply: [{ $ifNull: ['$stats.boostsCount', 0] }, 2] },
                    { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, 1.5] }
                  ]
                }
              }
            },
            { $sort: { engagementScore: -1, createdAt: -1 } },
            { $limit: limit + 1 }
          ]).option({ maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS });

        posts = 'createdAt' in query
          ? await runAnonPopular(undefined)
          : await fetchWithRecencyFallback(limit + 1, runAnonPopular);

        // Validate result size
        validateResultSize(posts, limit + 1);
      } else {
        // Authenticated users get chronological feed
        // For saved posts, sort by bookmark creation date (when saved), not post creation date
        if (feedType === 'saved' && savedPostIds.length > 0) {
          logger.debug(`[Saved Feed] Query`, JSON.stringify(query, null, 2));
          posts = await Post.find(query)
            .select(this.FEED_FIELDS)
            .sort({ createdAt: -1 })
            .limit(limit + 1)
            .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
            .lean();
          logger.debug(`[Saved Feed] Found ${posts.length} posts matching query`);
          // Log mentions for debugging
          if (posts.length > 0) {
            const samplePost = posts[0];
            logger.debug(`[Saved Feed] Sample post mentions`, samplePost?.mentions);
            logger.debug(`[Saved Feed] Sample post content.text`, samplePost?.content?.text?.substring(0, 100));
          }
        } else if (feedSort === 'oldest' && feedType === 'replies') {
          // Sort replies by creation date ascending for "oldest first"
          posts = await Post.find(query)
            .select(this.FEED_FIELDS)
            .sort({ createdAt: 1 })
            .limit(limit + 1)
            .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
            .lean();
        } else if (feedSort === 'best' && feedType === 'replies') {
          // Sort replies by engagement (likes + boosts) for "best" sort
          posts = await Post.aggregate([
            { $match: query },
            {
              $project: {
                _id: 1,
                oxyUserId: 1,
                createdAt: 1,
                visibility: 1,
                type: 1,
                parentPostId: 1,
                boostOf: 1,
                quoteOf: 1,
                threadId: 1,
                content: 1,
                stats: 1,
                metadata: 1,
                hashtags: 1,
                mentions: 1,
                language: 1
              }
            },
            {
              $addFields: {
                engagementScore: {
                  $add: [
                    { $ifNull: ['$stats.likesCount', 0] },
                    { $multiply: [{ $ifNull: ['$stats.boostsCount', 0] }, 2] },
                    { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, 1.5] }
                  ]
                }
              }
            },
            { $sort: { engagementScore: -1, createdAt: -1 } },
            { $limit: limit + 1 }
          ]).option({ maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS });
        } else {
          posts = await Post.find(query)
            .select(this.FEED_FIELDS)
            .sort({ createdAt: -1 })
            .limit(limit + 1)
            .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
            .lean();
        }

        // Validate result size
        validateResultSize(posts, limit + 1);
      }

      // Filter out posts from blocked/muted users
      let filteredPosts = posts;
      if (currentUserId) {
        const blockedAndMutedIds = await this.getBlockedAndMutedUserIds(currentUserId);
        filteredPosts = this.filterBlockedAndMutedPosts(posts, blockedAndMutedIds);
      }

      // Build response: saved posts use flat response, other feeds use thread slicing
      let response;
      if (feedType === 'saved') {
        response = await FeedResponseBuilder.buildSavedPostsResponse(
          filteredPosts,
          limit,
          cursor,
          (postsToTransform, userId) => this.transformPostsWithProfiles(postsToTransform, userId, createScopedOxyClient(req)),
          currentUserId
        );
      } else {
        // Thread slicing for mixed/posts/replies feeds
        const hasMore = filteredPosts.length > limit;
        const postsToSlice = hasMore ? filteredPosts.slice(0, limit) : filteredPosts;

        const { slices: rawSlices } = await threadSlicingService.sliceFeed(postsToSlice, {
          enableThreadGrouping: true,
          enableReplyContext: true,
          maxSliceSize: 3,
          viewerId: currentUserId,
        });

        const hydratedSlices = await postHydrationService.hydrateSlices(rawSlices, {
          viewerId: currentUserId,
          oxyClient: createScopedOxyClient(req),
          maxDepth: 0,
          includeLinkMetadata: true,
          includeFullArticleBody: false,
          includeFullMetadata: false,
        });

        response = FeedResponseBuilder.buildSlicedResponse({
          slices: hydratedSlices,
          limit,
          previousCursor: cursor,
          hasMore,
        });
      }

      // DON'T emit feed:updated for fetch requests - this causes duplicates!
      // Socket feed:updated events should only be emitted when new posts are created,
      // not when users fetch/load feeds. The frontend already has the posts from the HTTP response.
      // Emitting here causes duplicate posts because:
      // 1. HTTP response adds posts to feed
      // 2. Socket event arrives and tries to add same posts again
      // Socket updates are handled in post creation endpoints, not here.

      // Enterprise-grade performance monitoring
      const duration = Date.now() - startTime;
      const performanceMetrics = {
        type,
        duration,
        itemCount: response.items.length,
        cursor: cursor ? 'present' : 'none',
        hasMore: response.hasMore
      };
      
      // Record metrics
      metrics.recordLatency('feed_request_duration_ms', duration, { feed_type: type });
      metrics.incrementCounter('feed_requests_total', 1, { feed_type: type });
      metrics.setGauge('feed_items_returned', response.items.length, { feed_type: type });
      
      if (duration > this.SLOW_QUERY_THRESHOLD_MS) {
        logger.warn(`[Feed] Slow query detected: ${duration}ms`, performanceMetrics);
        metrics.incrementCounter('feed_slow_queries_total', 1, { feed_type: type });
      } else if (process.env.NODE_ENV === 'development') {
        logger.debug(`[Feed] Query completed: ${duration}ms`, performanceMetrics);
      }

      // Cache the freshly built anonymous page (fail-soft; no-op for
      // authenticated requests). Written after the response is fully built so
      // the cached value is byte-identical to a live build.
      if (anonCacheKey) {
        await anonFeedCache.write(anonCacheKey, response);
      }

      res.json(response);
    } catch (error) {
      const duration = Date.now() - startTime;
      const feedType = (req.query.type as string) || 'unknown';
      metrics.recordLatency('feed_request_duration_ms', duration, { feed_type: feedType, status: 'error' });
      metrics.incrementCounter('feed_errors_total', 1, { feed_type: feedType });
      logger.error('Error fetching feed', { 
        error, 
        type: req.query.type,
        duration: `${duration}ms`,
        message: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({ 
        error: 'Failed to fetch feed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get user profile feed
   */
  async getUserProfileFeed(req: AuthRequest, res: Response) {
    try {
      const userId = req.params.userId as string;
      const { cursor, type = 'posts' } = req.query as {
        cursor?: string;
        type?: FeedType
      };

      // Validate and sanitize limit parameter using utility
      const limit = validateAndNormalizeLimit(req.query.limit, FEED_CONSTANTS.DEFAULT_LIMIT);
      const currentUserId = req.user?.id;

      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // CRITICAL: Check profile privacy settings FIRST, before any database queries
      // This prevents fetching posts that will be filtered out
      const userSettings = await UserSettings.findOne({ oxyUserId: userId }).lean();
      const profileVisibility = userSettings?.privacy?.profileVisibility || ProfileVisibility.PUBLIC;
      const isOwnProfile = currentUserId === userId;
      
      // If profile is private or followers_only, check access BEFORE fetching posts
      if (!isOwnProfile && requiresAccessCheck(profileVisibility)) {
        if (!currentUserId) {
          // Not authenticated - return empty feed immediately
          return res.json(FeedResponseBuilder.buildEmptyResponse());
        }
        
        // Check if current user is following the profile owner
        const hasAccess = await checkFollowAccess(currentUserId, userId);
        if (!hasAccess) {
          // No access - return empty feed immediately, BEFORE any post queries
          return res.json(FeedResponseBuilder.buildEmptyResponse());
        }
      }

      // Only proceed with fetching posts if privacy check passes
      // Handle Likes feed separately (posts the user liked)
      if (type === 'likes') {
        // Paginate likes by Like document _id (chronological like order)
        const likeQuery: FilterQuery<ILike> = { userId };
        const cursorId = parseFeedCursor(cursor);
        if (cursorId) {
          likeQuery._id = { $lt: cursorId };
        }

        const likes = await Like.find(likeQuery)
          .sort({ _id: -1 })
          .limit(Number(limit) + 1)
          .lean();

        const hasMore = likes.length > Number(limit);
        const likesToReturn = hasMore ? likes.slice(0, Number(limit)) : likes;
        const nextCursor = hasMore ? likes[Number(limit) - 1]._id.toString() : undefined;

        const likedPostIds = likesToReturn.map(l => l.postId);
        if (likedPostIds.length === 0) {
          return res.json(FeedResponseBuilder.buildEmptyResponse());
        }

        const posts = await Post.find({
          _id: { $in: likedPostIds },
          visibility: PostVisibility.PUBLIC
        })
        .select(this.FEED_FIELDS)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();
      
      // Validate result size
      validateResultSize(posts, likedPostIds.length);

        // Preserve the like order
        const postsOrdered = likedPostIds
          .map(id => posts.find(p => p._id.toString() === id.toString()))
          .filter((p): p is (typeof posts)[number] => Boolean(p));

        // Use FeedResponseBuilder for consistent response building
        const response = await FeedResponseBuilder.buildResponse({
          posts: postsOrdered,
          limit,
          previousCursor: cursor,
          transformPosts: (postsToTransform, userId) => this.transformPostsWithProfiles(postsToTransform, userId, createScopedOxyClient(req)),
          currentUserId,
          validateSize: false // Already validated above
        });

        return res.json(response);
      }

      // Use FeedQueryBuilder for consistent query building
      const query = FeedQueryBuilder.buildUserProfileQuery(userId, type, cursor);

      let posts = await Post.find(query)
        .select(this.FEED_FIELDS)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();

      // If no posts found on the first page, check if this is a federated user
      // and sync their ActivityPub outbox. ALL federation network I/O (Oxy user
      // lookup, actor fetch, outbox sync, image downloads) runs as a TRUE
      // background task — the request NEVER blocks on remote federation I/O.
      // When there are no local posts yet for a (potentially) federated user we
      // return immediately with `pending: true` so the client shows a loading
      // state and refetches shortly; the background task keeps populating posts
      // (and the actor profile/avatar/banner) for the next fetch.
      //
      // The only request-path work is a single cheap indexed DB lookup
      // (`FederatedActor.findOne`) to decide whether to mark the feed pending.
      let fedSyncPending = false;
      if (posts.length === 0 && !cursor && (FEDERATION_ENABLED || ATPROTO_ENABLED)) {
        const syncUserId = userId;
        const cachedActor = await FederatedActor.findOne({ oxyUserId: syncUserId })
          .lean<IFederatedActor>();

        if (cachedActor) {
          // Known federated user with no local posts yet → kick off background
          // outbox sync + actor refresh and tell the client the feed is being
          // populated so it polls, unless a recent sync already proved there
          // are no importable outbox items. No network I/O on the request path.
          fedSyncPending = this.shouldShowFederatedSyncPending(cachedActor);
          this.runFederatedProfileSyncInBackground(syncUserId, cachedActor);
        } else {
          // No cached actor row. This is either a local user with a genuinely
          // empty feed (most common — must stay unchanged: NOT pending) or a
          // federated user we've never resolved. Resolve identity in the
          // background (single Oxy lookup off the request path); if federated,
          // the background task creates the actor row + syncs, and the next
          // fetch will see `pending`/posts. We do NOT mark pending here to
          // avoid making local empty profiles poll.
          this.runFederatedProfileSyncInBackground(syncUserId, undefined);
        }
      }

      // Validate result size
      validateResultSize(posts, limit + 1);

      // Thread slicing for user profile feeds
      const hasMore = posts.length > limit;
      const postsToSlice = hasMore ? posts.slice(0, limit) : posts;

      const { slices: rawSlices } = await threadSlicingService.sliceFeed(postsToSlice, {
        enableThreadGrouping: true,
        enableReplyContext: false, // Profile feeds show user's own posts, no reply context needed
        maxSliceSize: 3,
        viewerId: currentUserId,
      });

      const hydratedSlices = await postHydrationService.hydrateSlices(rawSlices, {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
        includeFullArticleBody: false,
        includeFullMetadata: false,
      });

      // Build the next cursor from the LAST raw post of the capped page so the
      // cursor is a chronological keyset (`<ms>:<id>`) matching the
      // `createdAt: -1` sort and the ChronoCursor filter in
      // `buildUserProfileQuery`. Using the bare anchor-post `_id` (the
      // `buildSlicedResponse` default) reintroduces the sort/cursor mismatch
      // that silently drops federated boosts. Only set when there is another
      // page and the page is non-empty.
      let cursorFromLastSlice: string | undefined;
      if (hasMore && postsToSlice.length > 0) {
        const lastPost = postsToSlice[postsToSlice.length - 1];
        cursorFromLastSlice = ChronoCursor.build(String(lastPost._id), lastPost.createdAt);
      }

      const response = FeedResponseBuilder.buildSlicedResponse({
        slices: hydratedSlices,
        limit,
        previousCursor: cursor,
        cursorFromLastSlice,
        hasMore,
      });

      // Signal that a federated outbox sync is still populating posts in the
      // background so the client can show a loading state and refetch shortly.
      if (fedSyncPending) {
        response.pending = true;
      }

      res.json(response);
    } catch (error) {
      logger.error('Error fetching user profile feed', error);
      res.status(500).json({
        error: 'Failed to fetch user profile feed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Fire-and-forget background sync for a (potentially) federated profile.
   *
   * Performs ALL federation network I/O off the client request path:
   *  1. Resolves the Oxy user to find its `federation.actorUri` (only when we
   *     don't already have a cached actor row).
   *  2. Upserts a minimal FederatedActor (outbox URL) so the outbox sync can run
   *     immediately without waiting on a full actor fetch.
   *  3. Syncs the actor's outbox into local posts.
   *  4. Enqueues a full background actor refresh so avatar/banner/displayName
   *     populate (and refresh over time) for viewed profiles — followed or not.
   *
   * Never throws; all errors are logged. Returns void synchronously to the
   * caller (the work runs detached).
   */
  private runFederatedProfileSyncInBackground(syncUserId: string, cachedActor?: IFederatedActor): void {
    if (!FEDERATION_ENABLED && !ATPROTO_ENABLED) return;

    void (async () => {
      try {
        // Dispatch by the cached actor's network. atproto profiles backfill
        // through the atproto connector's pull-based author feed (no AP outbox
        // dance); the rest of this method is the ActivityPub outbox flow.
        if (cachedActor?.protocol === 'atproto') {
          if (cachedActor.uri) {
            const connector = connectorRegistry.connectorFor(cachedActor.uri);
            if (connector) {
              await connector.fetchPosts(cachedActor.uri, { limit: this.FED_OUTBOX_SYNC_LIMIT });
            }
          }
          return;
        }

        if (!FEDERATION_ENABLED) return;

        let actor: IFederatedActor | null = cachedActor ?? null;
        let refreshedActorForSync = false;
        let oxyIdentity:
          | { actorUri?: string; acctHint?: string }
          | undefined;

        const getOxyIdentity = async (): Promise<{ actorUri?: string; acctHint?: string }> => {
          if (oxyIdentity) return oxyIdentity;
          // Federated profile lookup is public — use the service client so it
          // works for unauthenticated viewers and avoids per-request token setup.
          const oxyLookupClient = getServiceOxyClient();
          const oxyUser: User = await oxyLookupClient.getUserById(syncUserId);
          oxyIdentity = {
            actorUri: typeof oxyUser.federation?.actorUri === 'string'
              ? oxyUser.federation.actorUri
              : undefined,
            acctHint: typeof oxyUser.username === 'string' && oxyUser.username.includes('@')
              ? oxyUser.username
              : undefined,
          };
          logger.info(`[FedSync] oxyUser.type=${oxyUser.type} federation.actorUri=${oxyIdentity.actorUri ?? 'missing'} username=${oxyIdentity.acctHint ?? 'missing'}`);
          return oxyIdentity;
        };

        const stampActorOxyUserId = async (): Promise<void> => {
          if (!actor || actor.oxyUserId) return;
          await FederatedActor.updateOne({ _id: actor._id }, { $set: { oxyUserId: syncUserId } });
          actor.oxyUserId = syncUserId;
        };

        logger.info(`[FedSync] background sync userId=${syncUserId} existingActor=${!!actor} outboxUrl=${actor?.outboxUrl ?? 'none'}`);

        if (!actor) {
          const { actorUri, acctHint } = await getOxyIdentity();
          if (!actorUri) {
            // Local user with an empty feed — nothing to sync.
            return;
          }

          // Fetch the real actor document so we use its advertised `outbox`
          // (and `inbox`) endpoints. Guessing `actorUri + '/outbox'` only happens
          // to work on Mastodon-style layouts and breaks non-Mastodon servers
          // (PeerTube, Lemmy, some Pleroma) whose outbox lives elsewhere.
          // `fetchRemoteActor` upserts the FederatedActor with the canonical
          // `outboxUrl`/`inboxUrl` taken from `actor.outbox`/`actor.inbox`.
          actor = await activityPubConnector.fetchRemoteActor(actorUri, false, acctHint);

          if (!actor) {
            // The remote actor fetch failed (network error, blocked domain,
            // unauthorized fetch, etc.). Fall back to a minimal FederatedActor
            // with a guessed outbox so the sync can still attempt Mastodon-style
            // layouts; the enqueued background refresh will correct it later.
            const domain = new URL(actorUri).hostname;
            const username = (acctHint || '').split('@')[0] || 'unknown';
            const acct = `${username}@${domain}`;
            const fallbackOutboxUrl = `${actorUri}${actorUri.endsWith('/') ? '' : '/'}outbox`;
            logger.info(`[FedSync] fetchRemoteActor failed for ${actorUri}; creating minimal FederatedActor with fallback outboxUrl=${fallbackOutboxUrl}`);
            actor = await FederatedActor.findOneAndUpdate(
              { uri: actorUri },
              {
                $set: {
                  uri: actorUri,
                  username,
                  domain,
                  acct,
                  inboxUrl: `${actorUri}${actorUri.endsWith('/') ? '' : '/'}inbox`,
                  outboxUrl: fallbackOutboxUrl,
                  oxyUserId: syncUserId,
                  lastFetchedAt: new Date(0), // Mark stale so the refresh below runs
                },
                $setOnInsert: { type: 'Person', manuallyApprovesFollowers: false, discoverable: true, memorial: false, suspended: false, fields: [], followersCount: 0, followingCount: 0, postsCount: 0 },
              },
              { upsert: true, returnDocument: 'after', lean: true },
            ) as IFederatedActor | null;
          } else {
            await stampActorOxyUserId();
          }
        } else {
          const { actorUri, acctHint } = await getOxyIdentity();
          const actorUriChanged = Boolean(actorUri && actorUri !== actor.uri);
          const actorAcctChanged = Boolean(acctHint && actor.acct?.toLowerCase() !== acctHint.toLowerCase());
          if (actorUriChanged || actorAcctChanged || this.shouldRefreshActorBeforeOutboxSync(actor)) {
            const refreshUri = actorUri || actor.uri;
            const refreshAcct = acctHint || actor.acct;
            logger.info(`[FedSync] refreshing cached actor before outbox sync for ${actor.acct}; actorUriChanged=${actorUriChanged} actorAcctChanged=${actorAcctChanged}`);
            const refreshed = await activityPubConnector.fetchRemoteActor(refreshUri, false, refreshAcct);
            if (refreshed) {
              actor = refreshed;
              refreshedActorForSync = true;
              await stampActorOxyUserId();
            } else {
              logger.info(`[FedSync] cached actor refresh failed before outbox sync for ${actor.acct}; using cached outboxUrl=${actor.outboxUrl ?? 'none'}`);
            }
          }
        }

        if (!actor) return;

        // Enqueue a full actor refresh (avatar/banner/displayName) for the viewed
        // profile. Guarded against refresh storms inside the ActivityPub connector.
        activityPubConnector.refreshActorInBackground(actor.uri, actor);

        if (actor.outboxUrl) {
          const outboxStatus = this.getCurrentOutboxBackfillStatus(actor);
          if (outboxStatus === 'unavailable') {
            logger.info(`[FedSync] outbox sync skipped (unavailable) for ${actor.acct}`);
            return;
          }

          // Cooldown: skip the (expensive) outbox re-fetch+dedupe if we synced
          // this actor's outbox within the cooldown window. Profile views are
          // frequent; the outbox rarely changes between back-to-back views.
          const shouldClassifyUntrackedOutbox = shouldForceUntrackedOutboxSync({
            outboxStatus,
            postsCount: actor.postsCount,
            lastOutboxSyncAt: actor.lastOutboxSyncAt,
            cooldownMs: OUTBOX_SYNC_MIN_INTERVAL_MS,
          });
          const syncedRecently = !refreshedActorForSync
            && !shouldClassifyUntrackedOutbox
            && isWithinOutboxSyncCooldown(actor.lastOutboxSyncAt, OUTBOX_SYNC_MIN_INTERVAL_MS);
          if (syncedRecently) {
            logger.info(`[FedSync] outbox sync skipped (cooldown) for ${actor.acct}`);
            return;
          }

          // Ensure the actor has oxyUserId before syncing so posts get the right author
          if (!actor.oxyUserId) {
            await FederatedActor.updateOne({ _id: actor._id }, { $set: { oxyUserId: syncUserId } });
            actor.oxyUserId = syncUserId;
          }
          const syncResult = await activityPubConnector.syncOutboxPostsDetailed(actor, this.FED_OUTBOX_SYNC_LIMIT);
          const syncedCount = syncResult.syncedCount;
          logger.info(`[FedSync] syncOutboxPosts returned ${syncedCount} for ${actor.acct}`);
          if (isPermanentlyUnavailableOutboxReason(syncResult.reason)) {
            await activityPubConnector.markOutboxBackfillUnavailable(actor, syncResult.reason);
          } else if (syncResult.shouldStampCooldown) {
            // Stamp the sync time so subsequent views honour the cooldown only
            // after a fetch that actually exposed an inspectable outbox.
            await FederatedActor.updateOne(
              { _id: actor._id },
              { $set: { lastOutboxSyncAt: new Date() } },
            );
          } else {
            logger.info(`[FedSync] not stamping outbox cooldown for ${actor.acct}; reason=${syncResult.reason ?? 'unknown'}`);
          }
          // Backfill oxyUserId on any posts that were stored without it
          if (syncedCount > 0) {
            await Post.updateMany(
              {
                'federation.activityId': { $gte: actor.uri + '/', $lt: actor.uri + '/\uffff' },
                oxyUserId: null,
              },
              { $set: { oxyUserId: syncUserId } },
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[FedSync] background profile sync failed for userId=${syncUserId}: ${message}`);
      }
    })();
  }

  private shouldRefreshActorBeforeOutboxSync(actor: IFederatedActor): boolean {
    if (!actor.outboxUrl) return true;
    const fetchedAt = actor.lastFetchedAt?.getTime();
    if (typeof fetchedAt !== 'number') return true;
    if (fetchedAt <= 0) return true;
    return Date.now() - fetchedAt > FEDERATED_ACTOR_PROFILE_STALE_MS;
  }

  private getCurrentOutboxBackfillStatus(actor: IFederatedActor): string | undefined {
    if (!actor.outboxUrl) return undefined;
    if (actor.outboxBackfill?.outboxUrl !== actor.outboxUrl) return undefined;
    return actor.outboxBackfill?.status;
  }

  private shouldShowFederatedSyncPending(actor: IFederatedActor): boolean {
    const outboxStatus = this.getCurrentOutboxBackfillStatus(actor);
    if (outboxStatus === 'unavailable' || outboxStatus === 'complete') return false;
    if (outboxStatus === 'pending') return true;

    const lastSyncMs = actor.lastOutboxSyncAt?.getTime();
    if (typeof lastSyncMs !== 'number') return true;
    return Date.now() - lastSyncMs >= OUTBOX_SYNC_MIN_INTERVAL_MS;
  }

  /**
   * Create a reply to a post
   */
  async createReply(req: AuthRequest, res: Response) {
    try {
  const { postId, content, mentions, hashtags } = req.body as CreateReplyRequest;
  // Accept content as either a string or an object; normalize to PostContent shape
  // The persisted reply content is the OUTPUT shape: the client-supplied podcast
  // is only `{ syraPodcastId }` (input), so we drop it here and re-attach the
  // server-denormalized show below; everything else carries over.
  const replyContent: PostContent = typeof content === 'string' ? { text: content } : { ...(content ?? { text: '' }), podcast: undefined };
      const currentUserId = req.user?.id;

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!content || !postId) {
        return res.status(400).json({ error: 'Content and post ID are required' });
      }

      // Fetch parent post to check reply permissions
      const parentPost = await Post.findById(postId)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();
      if (!parentPost) {
        return res.status(404).json({ error: 'Post not found' });
      }

      // Check reply permissions
      const permissions: string[] = parentPost.replyPermission || ['anyone'];

      if (!permissions.includes('anyone')) {
        const parentAuthorId = parentPost.oxyUserId ? String(parentPost.oxyUserId) : undefined;

        // If replying to own post, always allow
        if (parentAuthorId === currentUserId) {
          // Allow
        } else {
          let canReply = false;

          if (permissions.includes('nobody')) {
            canReply = false;
          } else {
            try {
              for (const perm of permissions) {
                if (canReply) break;
                switch (perm) {
                  case 'followers': {
                    if (!parentAuthorId) break;
                    const authorFollowers = await oxyClient.getUserFollowers(parentAuthorId);
                    canReply = authorFollowers?.followers?.some((f: FollowerRef) => {
                      const followerId = typeof f === 'string' ? f : (f.id || f._id);
                      return followerId === currentUserId || String(followerId) === String(currentUserId);
                    }) || false;
                    break;
                  }
                  case 'following': {
                    if (!parentAuthorId) break;
                    try {
                      const authorFollowing = await oxyClient.getUserFollowing(parentAuthorId);
                      const followingIds = extractFollowingIds(authorFollowing);
                      canReply = followingIds.includes(currentUserId);
                    } catch (error) {
                      logger.warn('Failed to check author following', error);
                    }
                    break;
                  }
                  case 'mentioned': {
                    canReply = (parentPost.mentions || []).some((m: FollowerRef) => {
                      const mentionId = typeof m === 'string' ? m : (m.id || m._id);
                      return mentionId === currentUserId || String(mentionId) === String(currentUserId);
                    });
                    break;
                  }
                }
              }
            } catch (error) {
              logger.error('Error checking reply permissions', error);
              canReply = false;
            }
          }

          if (!canReply) {
            return res.status(403).json({
              error: 'You do not have permission to reply to this post',
              replyPermission: permissions
            });
          }
        }
      }

  // Create reply post
      const mergedTags = mergeHashtags(replyContent?.text || '', hashtags);

      // A reply may attach a single Syra podcast show. Like createPost, the
      // client's reference is untrusted: re-resolve + denormalize the show
      // server-side so a reply can never persist fabricated podcast metadata. An
      // unresolvable show — or any podcast missing a usable id — is dropped.
      const replySanitizedPodcast = sanitizePodcast(typeof content === 'string' ? undefined : content?.podcast);
      if (replySanitizedPodcast) {
        try {
          replyContent.podcast = await resolvePodcastContent(replySanitizedPodcast.syraPodcastId);
        } catch (podcastError) {
          logger.warn('createReply: failed to resolve Syra podcast; dropping', { userId: currentUserId, syraPodcastId: replySanitizedPodcast.syraPodcastId, error: podcastError });
        }
      }

      // If reviewReplies is enabled, set visibility to pending or use a flag
      // For now, we'll still create it but mark it for review
      const reply = new Post({
        oxyUserId: currentUserId,
        authorship: buildAuthorship(currentUserId, []),
        type: PostType.TEXT,
        content: replyContent,
        visibility: parentPost.reviewReplies ? PostVisibility.PRIVATE : PostVisibility.PUBLIC,
        parentPostId: postId,
        threadId: parentPost.threadId || parentPost._id.toString(),
        hashtags: mergedTags,
        mentions: mentions || [],
        stats: {
          likesCount: 0,
          boostsCount: 0,
          commentsCount: 0,
          viewsCount: 0,
          sharesCount: 0
        }
      });

      // Stage-A deterministic classification. This native reply path saves the
      // doc directly (not via PostCreationService), so populate the baseline
      // fields here while keeping `status: 'pending'` so the AI batch still
      // enriches it. Best-effort: never block the reply on classification.
      try {
        const signals = baselineContentClassifier.classify({
          text: replyContent?.text,
          hashtags: mergedTags,
        });
        // `attempts` is internal bookkeeping (not on the PostClassification type);
        // the subschema default seeds it to 0 for the unset path. The subdoc
        // carries ONLY the multi-language `languages` array; the primary
        // (`languages[0]`) is written to the top-level AP `post.language`.
        reply.postClassification = {
          status: POST_CLASSIFICATION_PENDING,
          topics: signals.topics,
          languages: signals.languages,
          region: signals.region,
          hashtagsNorm: signals.hashtagsNorm,
          sensitive: signals.sensitive,
          scores: signals.scores,
          version: signals.version,
          classifiedAt: new Date(signals.classifiedAt),
        };
        const primaryLanguage = signals.languages[0];
        if (primaryLanguage != null) {
          reply.language = primaryLanguage;
        }
      } catch (classifyError) {
        logger.warn('createReply: baseline classification failed; saving with default pending', classifyError);
      }

      await reply.save();

      // MTN dual-write: a reply emits an `app.mention.feed.post` record with the
      // thread position (reply.root / reply.parent). The direct parent is
      // `parentPost`; the thread root is `parentPost.threadId` (or the parent
      // itself when it IS the root). Resolve the root owner with a lean lookup
      // only when the root differs from the parent. Best-effort, never blocks.
      try {
        const rootId = parentPost.threadId ? String(parentPost.threadId) : String(parentPost._id);
        const parentOwner = parentPost.oxyUserId ? String(parentPost.oxyUserId) : undefined;
        let rootOwner = rootId === String(parentPost._id) ? parentOwner : undefined;
        if (!rootOwner && rootId) {
          const rootPost = await Post.findById(rootId).select('oxyUserId').lean();
          rootOwner = rootPost?.oxyUserId ? String(rootPost.oxyUserId) : undefined;
        }
        const replyContext =
          parentOwner && rootOwner
            ? {
                root: { postId: rootId, oxyUserId: rootOwner },
                parent: { postId: String(postId), oxyUserId: parentOwner },
              }
            : undefined;
        await emitPostCreated(reply, { reply: replyContext });
      } catch (mtnError) {
        logger.error('createReply: MTN record emission failed', mtnError);
      }

      // Affinity graph: the replier expresses affinity toward the parent post's
      // author. Fire-and-forget — buffering must never block or fail the reply.
      const parentAuthorId = parentPost.oxyUserId ? String(parentPost.oxyUserId) : undefined;
      if (parentAuthorId) {
        void affinityEventService
          .record({ fromUserId: currentUserId, toUserId: parentAuthorId, type: 'reply', eventId: `reply:${String(reply._id)}` })
          .catch(() => undefined);
      }

      // Update parent post comment count
      await Post.findByIdAndUpdate(postId, {
        $inc: { 'stats.commentsCount': 1 }
      }, { maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS });

      // Hydrate the created reply at maxDepth 1 so the response + socket payload
      // carry the author summary and engagement shape (and, when the reply is a
      // quote, the embedded quoted card) — matching the feed/detail DTO instead
      // of a raw `.toObject()`.
      const [hydratedReply] = await postHydrationService.hydratePosts([reply.toObject()], {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
      });

      // Emit real-time update to post room only (not all clients)
      io.to(`post:${postId}`).emit('post:replied', {
        postId,
        reply: hydratedReply,
        timestamp: new Date().toISOString()
      });

      res.status(201).json({
        success: true,
        reply: hydratedReply
      });
    } catch (error) {
      logger.error('Error creating reply', error);
      res.status(500).json({ 
        error: 'Failed to create reply',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Create a boost
   */
  async createBoost(req: AuthRequest, res: Response) {
    try {
      const { originalPostId, content, mentions, hashtags } = req.body as CreateBoostRequest;
      const currentUserId = req.user?.id;
      const surface = readInteractionSurface(req.body);

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!originalPostId) {
        return res.status(400).json({ error: 'Original post ID is required' });
      }

      const originalPost = await Post.findById(originalPostId)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();
      const shareValidation = validatePublicShareTarget(originalPost, { action: 'boost' });
      if (!shareValidation.ok) {
        return res.status(shareValidation.status).json({ error: shareValidation.message });
      }

      // Check if user already boosted this
      const existingBoost = await Post.findOne({
        oxyUserId: currentUserId,
        boostOf: originalPostId
      })
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS);

      if (existingBoost) {
        return res.status(400).json({ error: 'You have already boosted this content' });
      }

      // Create boost
      const mergedTags = mergeHashtags(content?.text || '', hashtags);

      const boost = new Post({
        oxyUserId: currentUserId,
        authorship: buildAuthorship(currentUserId, []),
        type: PostType.BOOST,
        content: content || { text: '' },
        visibility: PostVisibility.PUBLIC,
        boostOf: originalPostId,
        hashtags: mergedTags,
        mentions: mentions || [],
        stats: {
          likesCount: 0,
          boostsCount: 0,
          commentsCount: 0,
          viewsCount: 0,
          sharesCount: 0
        }
      });

      await boost.save();

      // MTN dual-write: a boost emits an `app.mention.feed.repost` record whose
      // subject is the boosted original's MTN URI. Best-effort, never blocks.
      await emitRepostCreated(boost, String(originalPostId), originalPost?.oxyUserId?.toString?.());

      // Affinity graph: the booster expresses affinity toward the boosted post's
      // author. Fire-and-forget — buffering must never block or fail the boost.
      const boostedAuthorId = originalPost?.oxyUserId?.toString?.();
      if (boostedAuthorId) {
        void affinityEventService
          .record({ fromUserId: currentUserId, toUserId: boostedAuthorId, type: 'boost', eventId: `boost:${String(boost._id)}` })
          .catch(() => undefined);
      }

      // Update original post boost count and get the updated count
      const updatedPost = await Post.findByIdAndUpdate(
        originalPostId,
        { $inc: { 'stats.boostsCount': 1 } },
        { new: true, maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS }
      );

      // Record interaction for user preference learning
      try {
        await userPreferenceService.recordInteraction(currentUserId, originalPostId, 'boost', { surface });
      } catch (error) {
        logger.warn('Failed to record interaction for preferences', error);
      }

      // A boost has an intentionally empty content body and relies on `boostOf`
      // for its rendered content. Hydrate at maxDepth 1 so the response + socket
      // payload carry the embedded original, the author summary, and the engagement
      // shape — matching the feed/detail DTO instead of a raw `.toObject()`.
      const [hydratedBoost] = await postHydrationService.hydratePosts([boost.toObject()], {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
      });

      // Emit real-time update to post room only (not all clients)
      io.to(`post:${originalPostId}`).emit('post:boosted', {
        originalPostId,
        postId: originalPostId,
        boost: hydratedBoost,
        boostsCount: updatedPost?.stats?.boostsCount,
        userId: currentUserId,
        actorId: currentUserId,
        timestamp: new Date().toISOString()
      });

      res.status(201).json({
        success: true,
        boost: hydratedBoost
      });
    } catch (error) {
      logger.error('Error creating boost', error);
      res.status(500).json({
        error: 'Failed to create boost',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Like a post/reply/boost
   */
  async likeItem(req: AuthRequest, res: Response) {
    try {
      const { postId, type } = req.body as LikeRequest;
      const currentUserId = req.user?.id;
      const surface = readInteractionSurface(req.body);

      logger.debug(`[Like] Like request received: userId=${currentUserId}, postId=${postId}`);

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Check if user already liked this post using Like collection (more efficient)
      const existingLike = await Like.findOne({ userId: currentUserId, postId });
      const alreadyLiked = !!existingLike;
      
      const existingPost = await Post.findById(postId)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS);
      if (!existingPost) {
        return res.status(404).json({ error: 'Post not found' });
      }
      
      if (alreadyLiked) {
        logger.debug(`[Like] Post ${postId} already liked by user ${currentUserId}`);
        // Still record the interaction even if already liked (user expressed interest)
        try {
          await userPreferenceService.recordInteraction(currentUserId, postId, 'like', { surface });
          logger.debug(`[Like] Recorded interaction for already-liked post`);
        } catch (error) {
          logger.warn(`[Like] Failed to record interaction for already-liked post`, error);
        }
        return res.json({ 
          success: true, 
          liked: true,
          likesCount: existingPost.stats.likesCount,
          message: 'Already liked'
        });
      }

      logger.debug(`[Like] User ${currentUserId} liking post ${postId} (not already liked)`);

      // Create like record in Like collection (single source of truth)
      const createdLike = await Like.create({ userId: currentUserId, postId, source: surface });

      // Update post like count only (don't store in metadata.likedBy - too much data)
      const updateResult = await Post.findByIdAndUpdate(
        postId,
        {
          $inc: { 'stats.likesCount': 1 }
        },
        { new: true, maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS }
      );

      if (!updateResult) {
        return res.status(404).json({ error: 'Post not found' });
      }

      // MTN dual-write: emit an `app.mention.feed.like` record for the new like.
      await emitLikeCreated({
        likerOxyUserId: currentUserId,
        likeRkey: String(createdLike._id),
        likedPostId: postId,
        likedPostOwnerOxyUserId: existingPost.oxyUserId?.toString?.(),
      });

      // Affinity graph: the liker expresses affinity toward the post's author.
      // Fire-and-forget — buffering must never block or fail the like.
      const likedAuthorId = existingPost.oxyUserId?.toString?.();
      if (likedAuthorId) {
        void affinityEventService
          .record({ fromUserId: currentUserId, toUserId: likedAuthorId, type: 'like', eventId: `like:${String(createdLike._id)}` })
          .catch(() => undefined);
      }

      // Record interaction for user preference learning
      logger.debug(`[Like] Recording interaction for user ${currentUserId}, post ${postId}`);
      try {
        await userPreferenceService.recordInteraction(currentUserId, postId, 'like', { surface });
        logger.debug(`[Like] Successfully recorded interaction`);
      } catch (error) {
        logger.error(`[Like] Failed to record interaction for preferences`, error);
        // Don't fail the request if preference tracking fails, but log the error
      }

      // Emit real-time update to post room only (not all clients)
      io.to(`post:${postId}`).emit('post:liked', {
        postId,
        userId: currentUserId,
        likesCount: updateResult.stats.likesCount,
        timestamp: new Date().toISOString()
      });

      res.json({ 
        success: true, 
        liked: true,
        likesCount: updateResult.stats.likesCount
      });
    } catch (error) {
      logger.error('Error liking post', error);
      res.status(500).json({ 
        error: 'Failed to like post',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Unlike a post/reply/boost
   */
  async unlikeItem(req: AuthRequest, res: Response) {
    try {
      const { postId, type } = req.body as UnlikeRequest;
      const currentUserId = req.user?.id;

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Check if user has liked this post using Like collection
      const existingLike = await Like.findOne({ userId: currentUserId, postId });
      const hasLiked = !!existingLike;
      
      const existingPost = await Post.findById(postId)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS);
      if (!existingPost) {
        return res.status(404).json({ error: 'Post not found' });
      }
      
      if (!hasLiked) {
        return res.json({ 
          success: true, 
          liked: false,
          likesCount: existingPost.stats.likesCount,
          message: 'Not liked'
        });
      }

      // Remove like record from Like collection
      const removedLike = await Like.findOneAndDelete({ userId: currentUserId, postId });

      // Update post like count only (don't maintain metadata.likedBy - too much data)
      const updateResult = await Post.findByIdAndUpdate(
        postId,
        {
          $inc: { 'stats.likesCount': -1 }
        },
        { new: true, maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS }
      );

      if (!updateResult) {
        return res.status(404).json({ error: 'Post not found' });
      }

      // MTN dual-write: tombstone the like's `app.mention.feed.like` record.
      if (removedLike) {
        await emitTombstone({
          authorOxyUserId: currentUserId,
          tombstoneRkey: String(removedLike._id),
          subjectUri: likeRecordUri(currentUserId, String(removedLike._id)),
        });
      }

      // Emit real-time update to post room only (not all clients)
      io.to(`post:${postId}`).emit('post:unliked', {
        postId,
        userId: currentUserId,
        likesCount: updateResult.stats.likesCount,
        timestamp: new Date().toISOString()
      });

      res.json({ 
        success: true, 
        liked: false,
        likesCount: updateResult.stats.likesCount
      });
    } catch (error) {
      logger.error('Error unliking post', error);
      res.status(500).json({ 
        error: 'Failed to unlike post',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Unboost a post
   */
  async unboostItem(req: AuthRequest, res: Response) {
    try {
      const postId = req.params.postId as string;
      const currentUserId = req.user?.id;

      logger.debug('🔄 Unboost request', { postId, currentUserId });

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Interpret :postId as the ORIGINAL post ID for unboost operations.
      // Find and delete the boost document created by the current user that points to this original.
      const boost = await Post.findOneAndDelete({
        oxyUserId: currentUserId,
        boostOf: postId
      }, { maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS });

      if (!boost) {
        return res.status(404).json({ error: 'Boost not found' });
      }

      // MTN dual-write: tombstone the boost's `app.mention.feed.repost` record.
      // Only LOCAL boosts ever emitted a record.
      if (boost.federation == null && boost.oxyUserId) {
        await emitTombstone({
          authorOxyUserId: boost.oxyUserId,
          tombstoneRkey: String(boost._id),
          subjectUri: repostRecordUri(boost.oxyUserId, String(boost._id)),
        });
      }

      // Update original post boost count and get the updated count
      const updatedPost = await Post.findByIdAndUpdate(
        boost.boostOf,
        { $inc: { 'stats.boostsCount': -1 } },
        { new: true, maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS }
      );

      // Emit real-time update to post room only (not all clients)
      const boostOriginalId = boost.boostOf ? String(boost.boostOf) : '';
      io.to(`post:${boostOriginalId}`).emit('post:unboosted', {
        originalPostId: boost.boostOf,
        postId: boost.boostOf,
        boostId: boost._id,
        boostsCount: updatedPost?.stats?.boostsCount,
        userId: currentUserId,
        actorId: currentUserId,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        message: 'Boost removed successfully'
      });
    } catch (error) {
      logger.error('Error unboosting', error);
      res.status(500).json({
        error: 'Failed to unboost',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Save a post
   */
  async saveItem(req: AuthRequest, res: Response) {
    try {
      const postId = req.params.postId as string;
      const currentUserId = req.user?.id;
      const surface = readInteractionSurface(req.body);

      logger.debug(`[Save] Save request received: userId=${currentUserId}, postId=${postId}`);

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Check if user already saved this post
      const existingPost = await Post.findById(postId)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS);
      if (!existingPost) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const alreadySaved = existingPost.metadata?.savedBy?.includes(currentUserId);
      
      if (alreadySaved) {
        logger.debug(`[Save] Post ${postId} already saved by user ${currentUserId}`);
        // Still record the interaction even if already saved (user expressed interest)
        try {
          await userPreferenceService.recordInteraction(currentUserId, postId, 'save', { surface });
          logger.debug(`[Save] Recorded interaction for already-saved post`);
        } catch (error) {
          logger.warn(`[Save] Failed to record interaction for already-saved post`, error);
        }
        return res.json({ 
          success: true, 
          saved: true,
          message: 'Already saved'
        });
      }

      // Add user to savedBy array and create Bookmark record
      const [updateResult, upsertedBookmark] = await Promise.all([
        Post.findByIdAndUpdate(
          postId,
          {
            $addToSet: { 'metadata.savedBy': currentUserId }
          },
          { new: true, maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS }
        ),
        Bookmark.findOneAndUpdate(
          { userId: currentUserId, postId },
          { userId: currentUserId, postId },
          { upsert: true, new: true }
        )
      ]);

      // MTN dual-write: a save emits a PRIVATE `app.mention.feed.bookmark` record.
      if (upsertedBookmark) {
        await emitBookmarkCreated({
          ownerOxyUserId: currentUserId,
          bookmarkRkey: String(upsertedBookmark._id),
          bookmarkedPostId: postId,
          bookmarkedPostOwnerOxyUserId: existingPost.oxyUserId?.toString?.(),
        });
      }

      // Record interaction for user preference learning
      logger.debug(`[Save] Recording interaction for user ${currentUserId}, post ${postId}`);
      try {
        await userPreferenceService.recordInteraction(currentUserId, postId, 'save', { surface });
        logger.debug(`[Save] Successfully recorded interaction`);
      } catch (error) {
        logger.error(`[Save] Failed to record interaction for preferences`, error);
      }

      // Emit real-time update to user room only
      io.to(`user:${currentUserId}`).emit('post:saved', {
        postId,
        userId: currentUserId,
        timestamp: new Date().toISOString()
      });

      res.json({ 
        success: true, 
        saved: true
      });
    } catch (error) {
      logger.error('Error saving post', error);
      res.status(500).json({ 
        error: 'Failed to save post',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Unsave a post
   */
  async unsaveItem(req: AuthRequest, res: Response) {
    try {
      const postId = req.params.postId as string;
      const currentUserId = req.user?.id;

      logger.debug('🗑️ Unsave endpoint called', { postId, currentUserId, user: req.user });

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Check if user has saved this post
      const existingPost = await Post.findById(postId)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS);
      if (!existingPost) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const hasSaved = existingPost.metadata?.savedBy?.includes(currentUserId);
      
      if (!hasSaved) {
        return res.json({ 
          success: true, 
          saved: false,
          message: 'Not saved'
        });
      }

      // Remove user from savedBy array and delete Bookmark record
      const [updateResult, removedBookmark] = await Promise.all([
        Post.findByIdAndUpdate(
          postId,
          {
            $pull: { 'metadata.savedBy': currentUserId }
          },
          { new: true, maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS }
        ),
        Bookmark.findOneAndDelete({ userId: currentUserId, postId })
      ]);

      // MTN dual-write: an unsave tombstones the bookmark record (private chain).
      if (removedBookmark) {
        await emitTombstone({
          authorOxyUserId: currentUserId,
          tombstoneRkey: String(removedBookmark._id),
          subjectUri: bookmarkRecordUri(currentUserId, String(removedBookmark._id)),
        });
      }

      // Emit real-time update to user room only
      io.to(`user:${currentUserId}`).emit('post:unsaved', {
        postId,
        userId: currentUserId,
        timestamp: new Date().toISOString()
      });

      res.json({ 
        success: true, 
        saved: false
      });
    } catch (error) {
      logger.error('Error unsaving post', error);
      res.status(500).json({ 
        error: 'Failed to unsave post',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Debug endpoint to see raw post data
   */
  // Debug method removed for production

  /**
   * Resolve the ordered self-thread continuation documents for a self-thread root.
   *
   * Single source of truth for the spine query shared by BOTH
   * {@link getThreadContinuations} (renders the connected spine on the post-detail
   * screen) and {@link getRepliesFeed} (expands a root into its whole spine so
   * external replies to ANY spine node surface — Bluesky behavior). The match shape
   * mirrors ThreadSlicingService.fetchThreadChildren: every post in this thread by
   * the SAME author that hangs off the chain (`parentPostId` present), public +
   * published, in chronological (= thread) order, capped at
   * MAX_THREAD_CONTINUATION_DEPTH.
   *
   * Returns the lean documents (not just ids) so the continuation endpoint hydrates
   * them in a single query, while the replies feed maps them to ids — avoiding the
   * extra round-trip an id-only helper would force on `getThreadContinuations`. The
   * caller must already have verified `root` is a self-thread root
   * (`root.threadId === String(root._id)`).
   */
  private getSelfThreadContinuations(root: Pick<IPost, 'oxyUserId' | 'threadId'>) {
    return Post.find({
      threadId: String(root.threadId),
      oxyUserId: root.oxyUserId,
      parentPostId: { $ne: null, $exists: true },
      visibility: PostVisibility.PUBLIC,
      status: 'published',
    })
      .select(this.FEED_FIELDS)
      .sort({ createdAt: 1 })
      .limit(MAX_THREAD_CONTINUATION_DEPTH)
      .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
      .lean();
  }

  async getRepliesFeed(req: AuthRequest, res: Response) {
    try {
      const nestedFilters = req.query.filters as ParsedQs | undefined;
      const parentId = req.params.parentId
        || coerceQueryString(req.query['filters[parentPostId]'])
        || coerceQueryString(nestedFilters?.parentPostId);
      if (!parentId) {
        return res.json({ items: [], hasMore: false });
      }

      const currentUserId = req.user?.id;
      const limit = validateAndNormalizeLimit(req.query.limit, FEED_CONSTANTS.DEFAULT_LIMIT);
      const sort = req.query.sort as string | undefined;
      const cursor = req.query.cursor as string | undefined;

      // Detect whether the parent is a self-thread ROOT. A self-thread root anchors
      // its own id as `threadId` (see createThread); for such a post the replies feed
      // must surface external replies to ANY node of the OP's continuation spine
      // (root … cN) — Bluesky behavior — not just the root's direct children. The
      // findById is guarded on a valid ObjectId so a non-ObjectId parentId (and any
      // non-root post) simply skips spine expansion and keeps the single-parent query.
      const parent = mongoose.isValidObjectId(parentId)
        ? await Post.findById(parentId)
          .select('_id oxyUserId threadId')
          .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
          .lean()
        : null;
      const isSelfThreadRoot = !!parent?.threadId && String(parent.threadId) === String(parent._id);

      // The OP's own continuations are rendered as the connected spine on the client,
      // so they must NOT also appear as replies. Each continuation hangs off another
      // spine node (c1.parentPostId === root, c2.parentPostId === c1, …) and would
      // otherwise match the expanded parent filter, so exclude them by id. The root
      // has no parentPostId and can never appear as a reply.
      const continuationIds = isSelfThreadRoot && parent
        ? (await this.getSelfThreadContinuations(parent)).map((c) => String(c._id))
        : [];

      const query: FilterQuery<IPost> = {
        parentPostId: continuationIds.length > 0
          ? { $in: [String(parentId), ...continuationIds] }
          : String(parentId),
        visibility: PostVisibility.PUBLIC,
        status: 'published',
      };

      const idConditions: { $nin?: mongoose.Types.ObjectId[]; $lt?: mongoose.Types.ObjectId } = {};
      if (continuationIds.length > 0) {
        idConditions.$nin = continuationIds.map((cid) => new mongoose.Types.ObjectId(cid));
      }
      if (cursor) {
        const cursorId = parseFeedCursor(cursor);
        if (cursorId) idConditions.$lt = cursorId;
      }
      if (idConditions.$nin || idConditions.$lt) {
        query._id = idConditions;
      }

      const feedFieldsProject = Object.fromEntries(
        this.FEED_FIELDS.split(' ').map(f => [f, 1])
      );

      let posts;
      if (sort === 'best') {
        posts = await Post.aggregate([
          { $match: query },
          {
            $addFields: {
              engagementScore: {
                $add: [
                  { $ifNull: ['$stats.likesCount', 0] },
                  { $multiply: [{ $ifNull: ['$stats.boostsCount', 0] }, 2] },
                  { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, 1.5] },
                ],
              },
            },
          },
          { $sort: { engagementScore: -1, createdAt: -1 } },
          { $limit: limit + 1 },
          { $project: feedFieldsProject },
        ]).option({ maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS });
      } else {
        const sortOrder = sort === 'oldest' ? 1 : -1;
        posts = await Post.find(query)
          .select(this.FEED_FIELDS)
          .sort({ createdAt: sortOrder })
          .limit(limit + 1)
          .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
          .lean();
      }

      const hasMore = posts.length > limit;
      const slicedPosts = hasMore ? posts.slice(0, limit) : posts;

      let filteredPosts = slicedPosts;
      if (currentUserId) {
        const blockedAndMutedIds = await this.getBlockedAndMutedUserIds(currentUserId);
        filteredPosts = this.filterBlockedAndMutedPosts(slicedPosts, blockedAndMutedIds);
      }

      // Hydrate replies at maxDepth 1 so quoted/embedded context (e.g. a reply
      // that is also a quote, or a boosted reply) renders, matching peer
      // endpoints. transformPostsWithProfiles is pinned to maxDepth 0 for feed
      // performance, so hydrate directly here.
      const hydratedReplies = await postHydrationService.hydratePosts(filteredPosts, {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
      });
      const items = hydratedReplies.filter((post) => post?.id && post.user?.id);
      const nextCursor = hasMore && slicedPosts.length > 0 ? String(slicedPosts[slicedPosts.length - 1]._id) : undefined;

      return res.json({ items, hasMore, nextCursor });
    } catch (error) {
      logger.error('[getRepliesFeed] Error:', error);
      return res.status(500).json({ message: 'Error fetching replies' });
    }
  }

  /**
   * Get the author's self-thread continuation spine for a root post.
   *
   * A self-thread root authored from the composer stamps `threadId === <its own
   * id>` on the root and chains each continuation by the same author via
   * `parentPostId` (root → c1 → c2 …), all sharing that `threadId`. The feed
   * groups this into a single slice (see {@link ThreadSlicingService}), but the
   * generic replies endpoint only returns DIRECT children of one parent, so the
   * post-detail screen could not reconstruct the descending OP chain. This
   * endpoint returns that chain — the same single-author, linear spine the feed
   * slicer uses — ordered chronologically (root-first continuation order).
   *
   * Returns `{ items: [] }` for anything that is not a self-thread root (a plain
   * post, a reply, a mid-thread continuation, a boost, or a non-public root), so
   * the client can call it unconditionally and leave non-thread posts unchanged.
   */
  async getThreadContinuations(req: AuthRequest, res: Response) {
    try {
      const rootId = req.params.rootId;
      if (!rootId || !mongoose.isValidObjectId(rootId)) {
        return res.json({ items: [] });
      }

      const currentUserId = req.user?.id;

      // The spine only applies to a public, published root post whose `threadId`
      // points at itself — the canonical self-thread root signature. A mid-thread
      // continuation has `threadId === <root id> !== <its own id>`, so this guard
      // correctly yields an empty spine when the focused post is not the root.
      const root = await Post.findById(rootId)
        .select('_id oxyUserId threadId visibility status')
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();

      if (
        !root ||
        root.visibility !== PostVisibility.PUBLIC ||
        root.status !== 'published' ||
        !root.oxyUserId ||
        !root.threadId ||
        String(root.threadId) !== String(root._id)
      ) {
        return res.json({ items: [] });
      }

      // Single source of truth for the spine query (shared with getRepliesFeed,
      // which expands a root into this same spine to surface external replies to
      // any node). Identical match shape to ThreadSlicingService.fetchThreadChildren.
      const continuations = await this.getSelfThreadContinuations(root);

      if (continuations.length === 0) {
        return res.json({ items: [] });
      }

      // Hydrate at maxDepth 1 (mirrors getRepliesFeed) so quoted/embedded context
      // on a continuation renders.
      const hydrated = await postHydrationService.hydratePosts(continuations, {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
      });
      const items = hydrated.filter((post) => post?.id && post.user?.id);

      return res.json({ items });
    } catch (error) {
      logger.error('[getThreadContinuations] Error:', error);
      return res.status(500).json({ message: 'Error fetching thread continuations' });
    }
  }

  /**
   * Get a single feed item by ID with full transformation and user interactions
   */
  async getFeedItemById(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const currentUserId = req.user?.id;

      if (!id) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      const post = await Post.findById(id)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();
      if (!post) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const [transformed] = await this.transformPostsWithProfiles([post], currentUserId, createScopedOxyClient(req));

      return res.json(transformed);
    } catch (error) {
      logger.error('Error fetching feed item', error);
      res.status(500).json({ error: 'Failed to fetch feed item' });
    }
  }

  /**
   * Get pinned post for a user
   */
  async getPinnedPost(req: AuthRequest, res: Response) {
    try {
      const userId = req.params.userId as string;
      const currentUserId = req.user?.id;

      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Check privacy
      const userSettings = await UserSettings.findOne({ oxyUserId: userId }).lean();
      const profileVisibility = userSettings?.privacy?.profileVisibility || ProfileVisibility.PUBLIC;
      const isOwnProfile = currentUserId === userId;

      if (!isOwnProfile && requiresAccessCheck(profileVisibility)) {
        if (!currentUserId) {
          return res.json({ item: null });
        }
        const hasAccess = await checkFollowAccess(currentUserId, userId);
        if (!hasAccess) {
          return res.json({ item: null });
        }
      }

      const pinnedPost = await Post.findOne({
        oxyUserId: userId,
        'metadata.isPinned': true,
        visibility: PostVisibility.PUBLIC,
      }).sort({ updatedAt: -1 }).lean();

      if (!pinnedPost) {
        return res.json({ item: null });
      }

      const [hydrated] = await postHydrationService.hydratePosts([pinnedPost], {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
      });
      return res.json({ item: hydrated || null });
    } catch (error) {
      logger.error('Error fetching pinned post', error);
      res.status(500).json({ error: 'Failed to fetch pinned post' });
    }
  }
}

export const feedController = new FeedController();
export default feedController;
