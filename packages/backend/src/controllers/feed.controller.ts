import { Response, NextFunction } from 'express';
import { Post } from '../models/Post';
import Poll from '../models/Poll';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import Block from '../models/Block';
import Mute from '../models/Mute';
import {
  FeedRequest,
  CreateReplyRequest,
  CreateRepostRequest,
  LikeRequest,
  UnlikeRequest,
  FeedResponse,
  FeedType,
  PostType,
  PostVisibility,
  HydratedPost,
} from '@mention/shared-types';
import mongoose from 'mongoose';
import { io } from '../../server';
import { oxy as oxyClient } from '../../server';
import { feedRankingService } from '../services/FeedRankingService';
import { feedCacheService } from '../services/FeedCacheService';
import { feedSeenPostsService } from '../services/FeedSeenPostsService';
import { userPreferenceService } from '../services/UserPreferenceService';
import { postHydrationService } from '../services/PostHydrationService';
import UserBehavior from '../models/UserBehavior';
import UserSettings from '../models/UserSettings';
import { checkFollowAccess, extractFollowingIds, requiresAccessCheck, ProfileVisibility } from '../utils/privacyHelpers';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';
import { FeedQueryBuilder } from '../utils/feedQueryBuilder';
import { FeedResponseBuilder } from '../utils/FeedResponseBuilder';
import {
  validateAndNormalizeLimit,
  parseFeedFilters,
  parseFeedCursor,
  buildFeedCursor,
  validateCursorAdvanced,
  deduplicatePosts,
  validateResultSize,
  applyQueryOptimizations,
  FEED_CONSTANTS
} from '../utils/feedUtils';
import { metrics } from '../utils/metrics';
import { config } from '../config';
import { mergeHashtags } from '../utils/textProcessing';

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
  private readonly FEED_FIELDS = '_id oxyUserId createdAt visibility type parentPostId repostOf quoteOf threadId content stats metadata hashtags mentions language';

  /** Slow query threshold in milliseconds (logs warnings for queries exceeding this) */
  private readonly SLOW_QUERY_THRESHOLD_MS = config.feed.slowQueryThresholdMs;

  /** Candidate multiplier for ranked feeds (fetch 2x posts for ranking) */
  private readonly RANKED_FEED_CANDIDATE_MULTIPLIER = config.feed.rankedCandidateMultiplier;

  /** Score comparison epsilon for ranking (prevents floating point issues) */
  private readonly SCORE_EPSILON = config.feed.scoreEpsilon;

  /**
   * Replace [mention:userId] placeholders in text with [@displayName](username) format
   * This allows the frontend to render the display name without @ but keep it clickable
   */
  private async replaceMentionPlaceholders(text: string, mentions: string[]): Promise<string> {
    if (!text || !mentions || mentions.length === 0) {
      return text;
    }

    // Batch-fetch all mentioned users in parallel (fixes N+1 query)
    const uniqueUserIds = [...new Set(mentions)];
    const userDataMap = new Map<string, { username: string; displayName: string }>();

    const results = await Promise.allSettled(
      uniqueUserIds.map(async (userId) => {
        const userData = await oxyClient.getUserById(userId);
        const username = userData.username || 'user';
        const displayName = userData.name?.full || username;
        return { userId, username, displayName };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        userDataMap.set(result.value.userId, {
          username: result.value.username,
          displayName: result.value.displayName,
        });
      }
    }

    let resultText = text;
    for (const userId of mentions) {
      const userData = userDataMap.get(userId) || { username: 'user', displayName: 'User' };
      const placeholder = `[mention:${userId}]`;
      resultText = resultText.replace(
        new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        `[@${userData.displayName}](${userData.username})`
      );
    }

    return resultText;
  }

  /**
   * Transform posts to include full profile data and engagement stats
   * 
   * @param posts - Raw post documents from database
   * @param currentUserId - Current user ID for personalization
   * @returns Array of hydrated posts with user data and engagement stats
   */
  private async transformPostsWithProfiles(posts: unknown[], currentUserId?: string): Promise<HydratedPost[]> {
    try {
      if (!posts || posts.length === 0) {
        return [];
      }
      
      // Optimized hydration for feed items: maxDepth 0 (no nested posts) for better performance
      // Feed items don't need nested context - only detail views need depth 1
      const hydrated = await postHydrationService.hydratePosts(posts, {
        viewerId: currentUserId,
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
  private filterBlockedAndMutedPosts(posts: any[], blockedAndMutedIds: string[]): any[] {
    if (blockedAndMutedIds.length === 0) return posts;

    return posts.filter(post => {
      const authorId = post.oxyUserId?.toString() || post.oxyUserId;
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
      // Get all poll IDs from posts
      const pollIds = posts
        .map((post: any) => post?.content?.pollId)
        .filter(Boolean);

      if (pollIds.length === 0) {
        return posts;
      }

      // Fetch all polls in one query
      const polls = await Poll.find({ _id: { $in: pollIds } }).lean();
      
      // Create a map for quick lookup
      const pollMap = new Map();
      polls.forEach(poll => {
        pollMap.set(poll._id.toString(), {
          question: poll.question,
          options: poll.options.map((option: any) => option.text),
          endTime: poll.endsAt.toISOString(),
          votes: poll.options.reduce((acc: any, option: any, index: number) => {
            acc[index] = option.votes.length;
            return acc;
          }, {}),
          userVotes: poll.options.reduce((acc: any, option: any) => {
            option.votes.forEach((userId: string) => {
              acc[userId] = String(poll.options.indexOf(option));
            });
            return acc;
          }, {})
        });
      });

      // Add poll data to posts
      return posts.map((post: any) => {
        if (post?.content?.pollId) {
          const pollData = pollMap.get(post.content.pollId);
          if (pollData) {
            post.content.poll = pollData;
          }
        }
        return post;
      });
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
      const { type = 'mixed', cursor } = req.query as { type?: FeedType; cursor?: string };
      
      // Validate feed type (prevent injection and invalid types)
      const validFeedTypes: FeedType[] = ['mixed', 'posts', 'media', 'replies', 'reposts', 'saved', 'for_you', 'following', 'explore'];
      const feedType: FeedType = validFeedTypes.includes(type as FeedType) ? (type as FeedType) : 'mixed';
      
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
          const { CustomFeed } = require('../models/CustomFeed');
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
                const { AccountList } = require('../models/AccountList');
                const lists = await AccountList.find({ _id: { $in: feed.sourceListIds } }).lean();
                lists.forEach((l: any) => (l.memberOxyUserIds || []).forEach((id: string) => authors.push(id)));
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
              includeReposts: feed.includeReposts,
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
          const { AccountList } = require('../models/AccountList');
          const ids = String(filters.listIds || filters.listId)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          if (ids.length) {
            const lists = await AccountList.find({ _id: { $in: ids } }).lean();
            const authors = new Set(
              String(filters.authors || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            );
            lists.forEach((l: any) => (l.memberOxyUserIds || []).forEach((id: string) => authors.add(id)));
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

      // Build query
      let query: any;
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
        // Sort by engagement score (popular posts) for unauthenticated users
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
              repostOf: 1,
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
                  { $multiply: [{ $ifNull: ['$stats.repostsCount', 0] }, 2] },
                  { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, 1.5] }
                ]
              }
            }
          },
          { $sort: { engagementScore: -1, createdAt: -1 } },
          { $limit: limit + 1 }
        ]).option({ maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS });
        
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

      // Use FeedResponseBuilder for consistent response building
      const response = feedType === 'saved'
        ? await FeedResponseBuilder.buildSavedPostsResponse(
            filteredPosts,
            limit,
            cursor,
            (postsToTransform, userId) => this.transformPostsWithProfiles(postsToTransform, userId),
            currentUserId
          )
        : await FeedResponseBuilder.buildResponse({
            posts: filteredPosts,
            limit,
            previousCursor: cursor,
            transformPosts: (postsToTransform, userId) => this.transformPostsWithProfiles(postsToTransform, userId),
            currentUserId
          });

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
   * Get personalized For You feed (engagement-ranked)
   * For unauthenticated users, returns popular posts sorted by engagement
   */
  async getForYouFeed(req: AuthRequest, res: Response) {
    try {
      const { cursor } = req.query as { cursor?: string };
      
      // Validate and sanitize limit parameter using utility
      const limit = validateAndNormalizeLimit(req.query.limit, FEED_CONSTANTS.DEFAULT_LIMIT);
      const currentUserId = req.user?.id;

      // For unauthenticated users, return popular posts (simplified aggregation)
      if (!currentUserId) {
        const match: any = {
          visibility: PostVisibility.PUBLIC,
          $and: [
            { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
            { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
          ]
        };

        const cursorId = parseFeedCursor(cursor);
        if (cursorId) {
          match._id = { $lt: cursorId };
        }

        const posts = await Post.aggregate([
          { $match: match },
          {
            $project: {
              _id: 1,
              oxyUserId: 1,
              createdAt: 1,
              visibility: 1,
              type: 1,
              parentPostId: 1,
              repostOf: 1,
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
                  { $multiply: [{ $ifNull: ['$stats.repostsCount', 0] }, 2] },
                  { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, 1.5] }
                ]
              }
            }
          },
          { $sort: { engagementScore: -1, createdAt: -1 } },
          { $limit: limit + 1 }
        ]).option({ maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS });
        
        // Validate result size
        validateResultSize(posts, limit + 1);

        // Use FeedResponseBuilder for consistent response building
        const response = await FeedResponseBuilder.buildResponse({
          posts,
          limit,
          previousCursor: cursor,
          transformPosts: (postsToTransform, userId) => this.transformPostsWithProfiles(postsToTransform, userId),
          currentUserId
        });

        return res.json(response);
      }

      // Use advanced feed ranking service for authenticated users
      // Cache first page (no cursor) for better performance
      // For paginated requests (with cursor), skip cache as results are dynamic
      const isFirstPage = !cursor;
      
      // Get following list, user behavior, and feed settings for personalization
      // Cache these lookups for 5 minutes to reduce DB load
      let followingIds: string[] = [];
      let userBehavior: any = null;
      let feedSettings: any = null;
      
      try {
        if (currentUserId) {
          // Get following list (could be cached, but keeping simple for now)
          try {
          const followingRes = await oxyClient.getUserFollowing(currentUserId);
            followingIds = extractFollowingIds(followingRes);
          } catch (error) {
            logger.warn('Failed to load following list', error);
          }
          
          // Get user behavior for personalization
          userBehavior = await UserBehavior.findOne({ oxyUserId: currentUserId }).lean();
          
          // Get user feed settings
          try {
            const userSettings = await UserSettings.findOne({ oxyUserId: currentUserId }).lean();
            feedSettings = userSettings?.feedSettings || null;
          } catch (error) {
            logger.warn('Failed to load feed settings', error);
          }
        }
      } catch (e) {
        logger.error('ForYou: Failed to load user data; continuing with basic ranking', e);
      }
      
      // Note: Cache integration happens after feed computation
      // We compute fresh feeds to ensure consistency, then cache first page results
      // This approach ensures users always get fresh, personalized content

      // Fetch seen post IDs from Redis to prevent duplicates (industry-standard approach)
      // This tracks posts the user has already seen in this session, preventing them from
      // reappearing when scores change between requests
      const seenPostIds: string[] = currentUserId 
        ? await feedSeenPostsService.getSeenPostIds(currentUserId)
        : [];

      // Use FeedQueryBuilder for consistent query building
      const match = FeedQueryBuilder.buildForYouQuery(seenPostIds, cursor);

      // For ranked feeds (for_you), add cursor to seen posts to ensure it's excluded
      // This prevents the cursor post from appearing again due to ranking changes
      if (cursor && currentUserId) {
        const cursorId = parseFeedCursor(cursor);
        if (cursorId && !seenPostIds.includes(cursor)) {
          seenPostIds.push(cursor);
          // Mark cursor post as seen immediately to prevent it from appearing
          feedSeenPostsService.markPostsAsSeen(currentUserId, [cursor])
            .catch(error => {
              logger.warn('Failed to mark cursor post as seen (non-critical)', error);
            });
        }
      }

      // Get candidate posts (fetch more than needed for ranking)
      // Fetch multiplier ensures sufficient posts for ranking algorithm
      const candidateLimit = Number(limit) * this.RANKED_FEED_CANDIDATE_MULTIPLIER;

      let candidatePosts = await Post.find(match)
        .select(this.FEED_FIELDS)
        .sort({ createdAt: -1 })
        .limit(candidateLimit)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();
      
      // Validate result size
      validateResultSize(candidatePosts, candidateLimit);

      // Use advanced ranking service to rank and sort posts
      const rankedPosts = await feedRankingService.rankPosts(
        candidatePosts,
        currentUserId,
        {
          followingIds,
          userBehavior,
          feedSettings
        }
      );

      // Sort by score (descending), with _id as tiebreaker for consistent ordering
      const sortedPosts = rankedPosts.sort((a, b) => {
        const scoreA = (a as any).finalScore ?? 0;
        const scoreB = (b as any).finalScore ?? 0;
        const scoreDiff = scoreB - scoreA;
        
        // If scores are very close, use _id as tiebreaker for consistent ordering
        if (Math.abs(scoreDiff) < this.SCORE_EPSILON) {
          return a._id.toString().localeCompare(b._id.toString()) * -1; // Descending
        }
        return scoreDiff;
      });

      // Slice to limit + 1 before validation (ranked posts can be up to candidateLimit)
      let posts = sortedPosts.slice(0, limit + 1);

      // Filter out posts from blocked/muted users
      if (currentUserId) {
        const blockedAndMutedIds = await this.getBlockedAndMutedUserIds(currentUserId);
        posts = this.filterBlockedAndMutedPosts(posts, blockedAndMutedIds);
      }

      // Use FeedResponseBuilder for consistent response building
      // Note: We need to handle privacy filtering separately as it's applied after transformation
      const response = await FeedResponseBuilder.buildResponse({
        posts,
        limit,
        previousCursor: cursor,
        transformPosts: (postsToTransform, userId) => this.transformPostsWithProfiles(postsToTransform, userId),
        currentUserId
      });

      // FINAL VERIFICATION: Log what we're sending to ensure no duplicates
      const responseIds = response.items.map(p => p.id?.toString() || 'NO_ID');
      const uniqueResponseIds = new Set(responseIds);
      
      logger.debug('📤 For You feed response', {
        requestCursor: cursor ? (cursor.length > 50 ? cursor.substring(0, 50) + '...' : cursor) : 'none',
        totalPosts: response.items.length,
        uniqueIds: uniqueResponseIds.size,
        hasMore: response.hasMore,
        hasCursor: !!response.nextCursor,
        firstPostId: responseIds[0] || 'none',
        lastPostId: responseIds[responseIds.length - 1] || 'none'
      });
      
      if (responseIds.length !== uniqueResponseIds.size) {
        const duplicates = responseIds.filter((id, idx) => responseIds.indexOf(id) !== idx);
        logger.error('🚨 CRITICAL: Backend sending duplicate IDs', [...new Set(duplicates)]);
      }

      res.json(response);

      // Mark returned posts as seen in Redis (async, non-blocking)
      // This prevents these posts from appearing in future pagination requests
      // Industry-standard approach: track seen posts server-side, not in cursor
      if (currentUserId && response.items.length > 0) {
        const postIdsToMark = response.items
          .map((post: any) => post.id?.toString())
          .filter((id: string | undefined): id is string => !!id && id !== 'undefined' && id !== 'null');
        
        if (postIdsToMark.length > 0) {
          // Mark as seen asynchronously (don't block response)
          feedSeenPostsService.markPostsAsSeen(currentUserId, postIdsToMark)
            .catch(error => {
              // Log but don't fail - seen posts tracking is best-effort
              logger.warn('Failed to mark posts as seen (non-critical)', error);
            });
        }
      }
    } catch (error) {
      logger.error('Error fetching For You feed', error);
      res.status(500).json({ 
        error: 'Failed to fetch For You feed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get Following feed (posts from accounts the user follows)
   */
  async getFollowingFeed(req: AuthRequest, res: Response) {
    try {
      const { cursor } = req.query as { cursor?: string };
      
      // Validate and sanitize limit parameter using utility
      const limit = validateAndNormalizeLimit(req.query.limit, FEED_CONSTANTS.DEFAULT_LIMIT);
      const currentUserId = req.user?.id;
      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Get following list from Oxy
      const followingRes = await oxyClient.getUserFollowing(currentUserId);
      // Only include people the user follows, NOT the user's own posts
      const followingIds = [...new Set(extractFollowingIds(followingRes))];

      if (followingIds.length === 0) {
        return res.json(FeedResponseBuilder.buildEmptyResponse());
      }

      // Use FeedQueryBuilder for consistent query building
      const query = FeedQueryBuilder.buildFollowingQuery(followingIds, cursor);

      let posts = await Post.find(query)
        .select(this.FEED_FIELDS)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();

      // Validate result size
      validateResultSize(posts, limit + 1);

      // Filter out posts from blocked/muted users
      if (currentUserId) {
        const blockedAndMutedIds = await this.getBlockedAndMutedUserIds(currentUserId);
        posts = this.filterBlockedAndMutedPosts(posts, blockedAndMutedIds);
      }

      // Use FeedResponseBuilder for consistent response building
      const response = await FeedResponseBuilder.buildResponse({
        posts,
        limit,
        previousCursor: cursor,
        transformPosts: (postsToTransform, userId) => this.transformPostsWithProfiles(postsToTransform, userId),
        currentUserId
      });

      res.json(response);
    } catch (error) {
      logger.error('Error fetching Following feed', error);
      res.status(500).json({ 
        error: 'Failed to fetch Following feed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get explore feed (trending posts)
   * Returns posts from the ENTIRE NETWORK sorted by engagement (likes, reposts, replies)
   * This is NOT filtered by following - it shows trending posts from all users
   */
  async getExploreFeed(req: AuthRequest, res: Response) {
    try {
      // Validate and sanitize inputs using utility
      const limit = validateAndNormalizeLimit(req.query.limit, FEED_CONSTANTS.DEFAULT_LIMIT);
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : undefined;
      const currentUserId = req.user?.id;

      // Build query for trending posts from ALL USERS in the network
      // INCLUDES the current user's own posts - no filtering by oxyUserId
      // No filtering by following - shows trending posts from everyone including yourself
      // Exclude replies and reposts - only show original top-level posts
      // Use $and to properly combine conditions
      let match: any = {
        visibility: PostVisibility.PUBLIC,
        // NO oxyUserId filter - includes posts from ALL users (including current user)
        $and: [
          // Exclude replies: parentPostId must be null or not exist
          {
            $or: [
              { parentPostId: null },
              { parentPostId: { $exists: false } }
            ]
          },
          // Exclude reposts: repostOf must be null or not exist
          {
            $or: [
              { repostOf: null },
              { repostOf: { $exists: false } }
            ]
          }
        ]
      };

      // If no posts match the strict criteria, try a more permissive query
      const totalMatchingPosts = await Post.countDocuments(match);
      if (totalMatchingPosts === 0) {
        // Fallback: try simpler query (just visibility, including replies/reposts)
        const simpleMatch = { visibility: PostVisibility.PUBLIC };
        const simpleCount = await Post.countDocuments(simpleMatch);
        if (simpleCount > 0) {
          match = simpleMatch;
        } else {
          // Try lowercase visibility string as fallback
          const altMatch = { visibility: 'public' };
          const altCount = await Post.countDocuments(altMatch);
          if (altCount > 0) {
            match = altMatch;
          }
        }
      }

      // Apply cursor using utility
      const cursorId = parseFeedCursor(cursor);
      if (cursorId) {
        match._id = { $lt: cursorId };
        logger.debug('📌 Using ObjectId cursor for explore feed', cursor);
      }

      // Calculate trending score based on raw engagement metrics
      // Prioritize: likes, replies, reposts, saves, views
      // Use insights for quality filtering but prioritize total engagement
      const posts = await Post.aggregate([
        { $match: match },
        {
          $project: {
            _id: 1,
            oxyUserId: 1,
            createdAt: 1,
            visibility: 1,
            type: 1,
            parentPostId: 1,
            repostOf: 1,
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
            // Get bookmark/save count from metadata.savedBy array length
            savesCount: { $size: { $ifNull: ['$metadata.savedBy', []] } },
            // Calculate comprehensive engagement score with weighted metrics
            // Higher weights for more valuable engagement types
            trendingScore: {
              $add: [
                { $ifNull: ['$stats.likesCount', 0] }, // Likes: 1x
                { $multiply: [{ $ifNull: ['$stats.repostsCount', 0] }, 3] }, // Reposts: 3x (high value)
                { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, 2.5] }, // Replies/Comments: 2.5x (high value)
                { $multiply: [{ $size: { $ifNull: ['$metadata.savedBy', []] } }, 2] }, // Saves: 2x (high value)
                { $multiply: [{ $ifNull: ['$stats.viewsCount', 0] }, 0.1] }, // Views: 0.1x (lower weight)
                { $multiply: [{ $ifNull: ['$stats.sharesCount', 0] }, 2] }, // Shares: 2x
              ]
            },
          }
        },
        // Sort by trending score (highest first), then by _id for consistent ordering
        { $sort: { trendingScore: -1, _id: -1 } },
        { $limit: limit + 1 }
      ]).option({ maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS });
      
      // Validate result size
      validateResultSize(posts, limit + 1);

      // Filter out posts from blocked/muted users
      let filteredPosts = posts;
      if (currentUserId) {
        const blockedAndMutedIds = await this.getBlockedAndMutedUserIds(currentUserId);
        filteredPosts = this.filterBlockedAndMutedPosts(posts, blockedAndMutedIds);
      }

      // Use FeedResponseBuilder for consistent response building
      const response = await FeedResponseBuilder.buildResponse({
        posts: filteredPosts,
        limit,
        previousCursor: cursor,
        transformPosts: (postsToTransform, userId) => this.transformPostsWithProfiles(postsToTransform, userId),
        currentUserId
      });

      res.json(response);
    } catch (error) {
      logger.error('Error fetching explore feed', error);
      res.status(500).json({ 
        error: 'Failed to fetch explore feed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get media feed (posts with images/videos)
   */
  async getMediaFeed(req: AuthRequest, res: Response) {
    try {
      const { cursor } = req.query as { cursor?: string };
      
      // Validate and sanitize limit parameter using utility
      const limit = validateAndNormalizeLimit(req.query.limit, FEED_CONSTANTS.DEFAULT_LIMIT);
      const currentUserId = req.user?.id;

      // Use FeedQueryBuilder for consistent query building
      const query = FeedQueryBuilder.buildMediaQuery(cursor);

      let posts = await Post.find(query)
        .select(this.FEED_FIELDS)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();

      validateResultSize(posts, limit + 1);

      // Filter out posts from blocked/muted users
      if (currentUserId) {
        const blockedAndMutedIds = await this.getBlockedAndMutedUserIds(currentUserId);
        posts = this.filterBlockedAndMutedPosts(posts, blockedAndMutedIds);
      }

      // Use FeedResponseBuilder for consistent response building
      const response = await FeedResponseBuilder.buildResponse({
        posts,
        limit,
        previousCursor: cursor,
        transformPosts: (postsToTransform, userId) => this.transformPostsWithProfiles(postsToTransform, userId),
        currentUserId
      });

      res.json(response);
    } catch (error) {
      logger.error('Error fetching media feed', error);
      res.status(500).json({ 
        error: 'Failed to fetch media feed',
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
        const likeQuery: any = { userId };
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
          .filter(Boolean) as any[];

        // Use FeedResponseBuilder for consistent response building
        const response = await FeedResponseBuilder.buildResponse({
          posts: postsOrdered,
          limit,
          previousCursor: cursor,
          transformPosts: (postsToTransform, userId) => this.transformPostsWithProfiles(postsToTransform, userId),
          currentUserId,
          validateSize: false // Already validated above
        });

        return res.json(response);
      }

      // Use FeedQueryBuilder for consistent query building
      const query = FeedQueryBuilder.buildUserProfileQuery(userId, type, cursor);

      const posts = await Post.find(query)
        .select(this.FEED_FIELDS)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();
      
      // Validate result size
      validateResultSize(posts, limit + 1);

      // Use FeedResponseBuilder for consistent response building
      const response = await FeedResponseBuilder.buildResponse({
        posts,
        limit,
        previousCursor: cursor,
        transformPosts: (postsToTransform, userId) => this.transformPostsWithProfiles(postsToTransform, userId),
        currentUserId
      });

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
   * Create a reply to a post
   */
  async createReply(req: AuthRequest, res: Response) {
    try {
  const { postId, content, mentions, hashtags } = req.body as CreateReplyRequest;
  // Accept content as either a string or an object; normalize to PostContent shape
  const replyContent = typeof content === 'string' ? { text: content } : (content || { text: '' });
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
      const replyPermission = parentPost.replyPermission || 'anyone';
      if (replyPermission !== 'anyone') {
        const parentAuthorId = parentPost.oxyUserId?.toString?.() || (parentPost as any).oxyUserId;
        
        // If replying to own post, always allow
        if (parentAuthorId === currentUserId) {
          // Allow
        } else {
          let canReply = false;
          
          try {
            switch (replyPermission) {
              case 'followers':
                // Check if current user is a follower of the post author
                const authorFollowers = await oxyClient.getUserFollowers(parentAuthorId);
                canReply = authorFollowers?.followers?.some((f: any) => {
                  const followerId = f.id || f._id || f;
                  return followerId === currentUserId || String(followerId) === String(currentUserId);
                }) || false;
                break;
              case 'following':
                // Check if post author follows current user (current user is in author's following list)
                try {
                const authorFollowing = await oxyClient.getUserFollowing(parentAuthorId);
                  const followingIds = extractFollowingIds(authorFollowing);
                  canReply = followingIds.includes(currentUserId);
                } catch (error) {
                  logger.warn('Failed to check author following', error);
                  canReply = false;
                }
                break;
              case 'mentioned':
                // Check if current user is mentioned in the post
                canReply = (parentPost.mentions || []).some((m: any) => {
                  const mentionId = typeof m === 'string' ? m : (m.id || m._id);
                  return mentionId === currentUserId || String(mentionId) === String(currentUserId);
                });
                break;
            }
          } catch (error) {
            logger.error('Error checking reply permissions', error);
            // If we can't verify, deny for safety
            canReply = false;
          }
          
          if (!canReply) {
            return res.status(403).json({ 
              error: 'You do not have permission to reply to this post',
              replyPermission 
            });
          }
        }
      }

  // Create reply post
      const mergedTags = mergeHashtags(replyContent?.text || '', hashtags);

      // If reviewReplies is enabled, set visibility to pending or use a flag
      // For now, we'll still create it but mark it for review
      const reply = new Post({
        oxyUserId: currentUserId,
        type: PostType.TEXT,
        content: replyContent,
        visibility: parentPost.reviewReplies ? PostVisibility.PRIVATE : PostVisibility.PUBLIC,
        parentPostId: postId,
        hashtags: mergedTags,
        mentions: mentions || [],
        stats: {
          likesCount: 0,
          repostsCount: 0,
          commentsCount: 0,
          viewsCount: 0,
          sharesCount: 0
        }
      });

      await reply.save();

      // Update parent post comment count
      await Post.findByIdAndUpdate(postId, {
        $inc: { 'stats.commentsCount': 1 }
      }, { maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS });

      // Emit real-time update to post room only (not all clients)
      io.to(`post:${postId}`).emit('post:replied', {
        postId,
        reply: reply.toObject(),
        timestamp: new Date().toISOString()
      });

      res.status(201).json({ 
        success: true, 
        reply: reply.toObject() 
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
   * Create a repost
   */
  async createRepost(req: AuthRequest, res: Response) {
    try {
      const { originalPostId, content, mentions, hashtags } = req.body as CreateRepostRequest;
      const currentUserId = req.user?.id;

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!originalPostId) {
        return res.status(400).json({ error: 'Original post ID is required' });
      }

      // Check if user already reposted this
      const existingRepost = await Post.findOne({
        oxyUserId: currentUserId,
        repostOf: originalPostId
      })
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS);

      if (existingRepost) {
        return res.status(400).json({ error: 'You have already reposted this content' });
      }

      // Create repost
      const mergedTags = mergeHashtags(content?.text || '', hashtags);

      const repost = new Post({
        oxyUserId: currentUserId,
        type: PostType.REPOST,
        content: content || { text: '' },
        visibility: PostVisibility.PUBLIC,
        repostOf: originalPostId,
        hashtags: mergedTags,
        mentions: mentions || [],
        stats: {
          likesCount: 0,
          repostsCount: 0,
          commentsCount: 0,
          viewsCount: 0,
          sharesCount: 0
        }
      });

      await repost.save();

      // Update original post repost count and get the updated count
      const updatedPost = await Post.findByIdAndUpdate(
        originalPostId,
        { $inc: { 'stats.repostsCount': 1 } },
        { new: true, maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS }
      );

      // Record interaction for user preference learning
      try {
        await userPreferenceService.recordInteraction(currentUserId, originalPostId, 'repost');
        // Invalidate cached feed for this user
        await feedCacheService.invalidateUserCache(currentUserId);
      } catch (error) {
        logger.warn('Failed to record interaction for preferences', error);
      }

      // Emit real-time update to post room only (not all clients)
      io.to(`post:${originalPostId}`).emit('post:reposted', {
        originalPostId,
        postId: originalPostId,
        repost: repost.toObject(),
        repostsCount: updatedPost?.stats?.repostsCount,
        userId: currentUserId,
        actorId: currentUserId,
        timestamp: new Date().toISOString()
      });

      res.status(201).json({ 
        success: true, 
        repost: repost.toObject() 
      });
    } catch (error) {
      logger.error('Error creating repost', error);
      res.status(500).json({ 
        error: 'Failed to create repost',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Like a post/reply/repost
   */
  async likeItem(req: AuthRequest, res: Response) {
    try {
      const { postId, type } = req.body as LikeRequest;
      const currentUserId = req.user?.id;

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
          await userPreferenceService.recordInteraction(currentUserId, postId, 'like');
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
      await Like.create({ userId: currentUserId, postId });

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

      // Record interaction for user preference learning
      logger.debug(`[Like] Recording interaction for user ${currentUserId}, post ${postId}`);
      try {
        await userPreferenceService.recordInteraction(currentUserId, postId, 'like');
        logger.debug(`[Like] Successfully recorded interaction`);
        // Invalidate cached feed for this user
        await feedCacheService.invalidateUserCache(currentUserId);
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
   * Unlike a post/reply/repost
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
      await Like.deleteOne({ userId: currentUserId, postId });

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

      // Invalidate cached feed for this user
      try {
        await feedCacheService.invalidateUserCache(currentUserId);
      } catch (error) {
        logger.warn('Failed to invalidate cache', error);
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
   * Unrepost a post
   */
  async unrepostItem(req: AuthRequest, res: Response) {
    try {
      const postId = req.params.postId as string;
      const currentUserId = req.user?.id;

      logger.debug('🔄 Unrepost request', { postId, currentUserId });

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Interpret :postId as the ORIGINAL post ID for unrepost operations.
      // Find and delete the repost document created by the current user that points to this original.
      const repost = await Post.findOneAndDelete({
        oxyUserId: currentUserId,
        repostOf: postId
      }, { maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS });

      if (!repost) {
        return res.status(404).json({ error: 'Repost not found' });
      }

      // Update original post repost count and get the updated count
      const updatedPost = await Post.findByIdAndUpdate(
        repost.repostOf,
        { $inc: { 'stats.repostsCount': -1 } },
        { new: true, maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS }
      );

      // Emit real-time update to post room only (not all clients)
      const repostOriginalId = repost.repostOf ? String(repost.repostOf) : '';
      io.to(`post:${repostOriginalId}`).emit('post:unreposted', {
        originalPostId: repost.repostOf,
        postId: repost.repostOf,
        repostId: repost._id,
        repostsCount: updatedPost?.stats?.repostsCount,
        userId: currentUserId,
        actorId: currentUserId,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        message: 'Repost removed successfully'
      });
    } catch (error) {
      logger.error('Error unreposting', error);
      res.status(500).json({
        error: 'Failed to unrepost',
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
          await userPreferenceService.recordInteraction(currentUserId, postId, 'save');
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
      const [updateResult] = await Promise.all([
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

      // Record interaction for user preference learning
      logger.debug(`[Save] Recording interaction for user ${currentUserId}, post ${postId}`);
      try {
        await userPreferenceService.recordInteraction(currentUserId, postId, 'save');
        logger.debug(`[Save] Successfully recorded interaction`);
        // Invalidate cached feed for this user
        await feedCacheService.invalidateUserCache(currentUserId);
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
      const [updateResult] = await Promise.all([
        Post.findByIdAndUpdate(
          postId,
          {
            $pull: { 'metadata.savedBy': currentUserId }
          },
          { new: true, maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS }
        ),
        Bookmark.deleteOne({ userId: currentUserId, postId })
      ]);

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

  // Legacy methods for backward compatibility
  async getPostsFeed(req: AuthRequest, res: Response) {
    req.query.type = 'posts';
    return this.getFeed(req, res);
  }

  async getRepostsFeed(req: AuthRequest, res: Response) {
    req.query.type = 'reposts';
    return this.getFeed(req, res);
  }

  async getQuotesFeed(req: AuthRequest, res: Response) {
    req.query.type = 'quotes';
    return this.getFeed(req, res);
  }

  async getRepliesFeed(req: AuthRequest, res: Response) {
    req.query.type = 'replies';
    return this.getFeed(req, res);
  }

  /**
   * Get a single feed item by ID with full transformation and user interactions
   */
  async getFeedItemById(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params as any;
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

      const [transformed] = await this.transformPostsWithProfiles([post], currentUserId);

      return res.json(transformed);
    } catch (error) {
      logger.error('Error fetching feed item', error);
      res.status(500).json({ error: 'Failed to fetch feed item' });
    }
  }
}

export const feedController = new FeedController();
export default feedController;
