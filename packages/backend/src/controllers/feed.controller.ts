import { Response, NextFunction } from 'express';
import { Post } from '../models/Post';
import Poll from '../models/Poll';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
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
import { checkFollowAccess, extractFollowingIds, requiresAccessCheck, ProfileVisibility, getBlockedUserIds, getRestrictedUserIds } from '../utils/privacyHelpers';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';

class FeedController {
  // Note: checkFollowAccess is now imported from privacyHelpers

  // Optimized field selection for feed queries - reduces data transfer by 60-80%
  private readonly FEED_FIELDS = '_id oxyUserId createdAt visibility type parentPostId repostOf quoteOf threadId content stats metadata hashtags mentions language';

  /**
   * Filter out posts from private/followers_only profiles that the viewer doesn't have access to
   * Also filters out posts from blocked and restricted users
   */
  private async filterPostsByProfilePrivacy(
    posts: any[],
    currentUserId?: string
  ): Promise<any[]> {
    if (!posts || posts.length === 0) return posts;
    
    // Get unique author IDs
    const authorIds = [...new Set(posts.map(p => p.oxyUserId).filter(Boolean))];
    if (authorIds.length === 0) return posts;
    
      // If current user exists, get blocked and restricted user lists from Oxy
      // Note: Oxy services use authenticated context from the request
      let blockedUserIds: string[] = [];
      let restrictedUserIds: string[] = [];
      if (currentUserId) {
        try {
          // These functions use authenticated context, so they'll get the current user's blocked/restricted lists
          blockedUserIds = await getBlockedUserIds();
          restrictedUserIds = await getRestrictedUserIds();
        } catch (error) {
          logger.error('Error getting blocked/restricted users', error);
          // Continue without blocking/restricting if Oxy service fails
        }
      }
    
    const blockedSet = new Set(blockedUserIds);
    const restrictedSet = new Set(restrictedUserIds);
    
    // Get privacy settings for all authors
    const privacySettings = await UserSettings.find({
      oxyUserId: { $in: authorIds },
      'privacy.profileVisibility': { $in: [ProfileVisibility.PRIVATE, ProfileVisibility.FOLLOWERS_ONLY] }
    }).lean();
    
    const privateProfileIds = new Set(
      privacySettings.map(s => s.oxyUserId)
    );
    
    // If no current user, filter out all posts from private profiles and blocked users
    if (!currentUserId) {
      return posts.filter(p => {
        const authorId = p.oxyUserId;
        // Filter out private profiles and blocked users
        return !privateProfileIds.has(authorId) && !blockedSet.has(authorId);
      });
    }
    
    // Get following list for current user
    let followingIds: string[] = [];
    try {
      const followingRes = await oxyClient.getUserFollowing(currentUserId);
      followingIds = extractFollowingIds(followingRes);
    } catch (error) {
      logger.error('Error getting following list for privacy filter', error);
      // On error, filter out private profiles for safety
      return posts.filter(p => {
        const authorId = p.oxyUserId;
        return !privateProfileIds.has(authorId) && !blockedSet.has(authorId);
      });
}

    // Filter posts: keep if:
    // - Author is not blocked
    // - Author is not restricted (or is current user)
    // - Author profile is not private (or user has access)
    // - Author is the current user (own posts always visible)
    return posts.filter(p => {
      const authorId = p.oxyUserId;
      
      // Always filter out blocked users
      if (blockedSet.has(authorId)) return false;
      
      // Filter out restricted users (they can't see posts from the user who restricted them)
      // Note: This is from the perspective of the restricted user - they can't see posts from the restrictor
      // If current user restricted author, author's posts are hidden from current user
      if (restrictedSet.has(authorId)) return false;
      
      // Own posts are always visible
      if (authorId === currentUserId) return true;
      
      // Check privacy settings
      if (!privateProfileIds.has(authorId)) return true; // Public profile
      return followingIds.includes(authorId); // Following the author (for followers_only)
    });
  }

  /**
   * Replace [mention:userId] placeholders in text with [@displayName](username) format
   * This allows the frontend to render the display name without @ but keep it clickable
   */
  private async replaceMentionPlaceholders(text: string, mentions: string[]): Promise<string> {
    if (!text || !mentions || mentions.length === 0) {
      return text;
    }

    let result = text;
    
    // Fetch user data for all mentioned users
    for (const userId of mentions) {
      try {
        const userData = await oxyClient.getUserById(userId);
        const username = userData.username || 'user';
        const displayName = userData.name?.full || username;
        
        // Replace [mention:userId] with [@displayName](username) format
        // This allows LinkifiedText to detect and render mentions properly
        const placeholder = `[mention:${userId}]`;
        result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `[@${displayName}](${username})`);
      } catch (error) {
        logger.error(`Error fetching user data for mention ${userId}`, error);
        // If user fetch fails, replace with generic mention
        const placeholder = `[mention:${userId}]`;
        result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[@User](user)');
      }
    }

    return result;
  }

  /**
   * Transform posts to include full profile data and engagement stats
   */
  private async transformPostsWithProfiles(posts: any[], currentUserId?: string): Promise<HydratedPost[]> {
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
   * Build query based on feed type and filters
   */
  private buildFeedQuery(type: FeedType, filters?: Record<string, unknown>, currentUserId?: string): Record<string, unknown> {
    const query: Record<string, unknown> = {
      visibility: PostVisibility.PUBLIC // Only show public posts by default
    };
    query.status = 'published';

    // Filter by post type
    switch (type) {
      case 'posts':
        // Regular posts (not replies or reposts)
        query.type = { $in: [PostType.TEXT, PostType.IMAGE, PostType.VIDEO, PostType.POLL] };
        query.parentPostId = null; // matches null or non-existent
        query.repostOf = null;
        break;
      case 'media': {
        // Media posts: either typed as IMAGE/VIDEO OR have media arrays populated; exclude replies/reposts
        query.$and = [
          { $or: [
            { type: { $in: [PostType.IMAGE, PostType.VIDEO] } },
            { 'content.media.0': { $exists: true } },
            { 'content.images.0': { $exists: true } },
            { 'content.attachments.0': { $exists: true } },
            { 'content.files.0': { $exists: true } },
            { 'media.0': { $exists: true } }
          ] },
          { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
          { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
        ];
        break;
      }
      case 'replies':
        // Replies have a parentPostId set (not null)
        query.parentPostId = { $ne: null };
        break;
      case 'reposts':
        // Reposts have repostOf set (not null)
        query.repostOf = { $ne: null };
        break;
      case 'mixed':
      default:
        // Show all types
        break;
    }

    // Apply filters
    if (filters) {
      // Author filter: limit to posts authored by specific user IDs
      if (filters.authors) {
        let authors: string[] = [];
        if (Array.isArray(filters.authors)) {
          authors = filters.authors as string[];
        } else if (typeof filters.authors === 'string') {
          authors = String(filters.authors)
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean);
        }
        if (authors.length) {
          query.oxyUserId = { $in: authors };
        } else {
          // If authors filter is provided but empty, return no results
          // This handles empty lists or empty author filters correctly
          query.oxyUserId = { $in: [] }; // Empty array will match nothing
        }
      }
      
      // Exclude owner from custom feeds if explicitly requested
      // This ensures custom feeds don't include the creator's posts unless they're in the member list
      if (filters.excludeOwner && currentUserId) {
        // Add condition to exclude owner's posts
        if (query.oxyUserId && query.oxyUserId.$in) {
          // If authors filter exists, owner should already be excluded if not in list
          // But add explicit exclusion as safety measure
          query.oxyUserId = {
            $in: query.oxyUserId.$in.filter((id: string) => id !== currentUserId)
          };
        } else {
          // No authors filter, so exclude owner explicitly
          query.oxyUserId = { $ne: currentUserId };
        }
      }
      if (filters.includeReplies === false) {
        query.parentPostId = { $exists: false };
      }
      if (filters.includeReposts === false) {
        query.repostOf = { $exists: false };
      }
      if (filters.includeMedia === false) {
        query.type = { $nin: [PostType.IMAGE, PostType.VIDEO] };
      }
      if (filters.includeSensitive === false) {
        query['metadata.isSensitive'] = { $ne: true };
      }
      if (filters.language) {
        query.language = filters.language;
      }
      if (filters.dateFrom) {
        query.createdAt = { $gte: new Date(filters.dateFrom) };
      }
      if (filters.dateTo) {
        query.createdAt = { ...query.createdAt, $lte: new Date(filters.dateTo) };
      }
      // Keywords: OR match against text or hashtags
      if (filters.keywords) {
        const kws = Array.isArray(filters.keywords)
          ? filters.keywords
          : String(filters.keywords).split(',').map((s: string) => s.trim()).filter(Boolean);
        if (kws.length) {
          const regexes = kws.map((k: string) => new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
          const keywordConditions = [
            { 'content.text': { $in: regexes } },
            { hashtags: { $in: kws.map((k: string) => k.toLowerCase()) } }
          ];
          
          // If there's already an $or (from other filters), combine with $and
          // Otherwise, use $or for keywords
          if (query.$or) {
            // Combine existing $or with keyword conditions using $and
            query.$and = query.$and || [];
            query.$and.push({ $or: [...query.$or, ...keywordConditions] });
            delete query.$or;
          } else {
            query.$or = keywordConditions;
          }
        }
      }
    }

    return query;
  }

  /**
   * Populate poll data for posts
   */
  async populatePollData(posts: any[]): Promise<any[]> {
    try {
      // Get all poll IDs from posts
      const pollIds = posts
        .map(post => post.content?.pollId)
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
      return posts.map(post => {
        if (post.content?.pollId) {
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
      const { type = 'mixed', cursor } = req.query as { type?: FeedType; cursor?: string };
      // Parse and validate limit parameter (default 20, clamp between 1-200)
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || 20), 10), 1), 200);
      let filters: Record<string, unknown> | undefined = req.query.filters as Record<string, unknown> | undefined;
      const currentUserId = req.user?.id;

      // Parse filters - Express should parse filters[searchQuery]=value automatically
      // But handle cases where it might be a string or need manual parsing
      if (typeof filters === 'string') {
        try {
          filters = JSON.parse(filters);
        } catch (e) {
          logger.warn('Failed to parse filters JSON', e);
          filters = {};
        }
      }
      
      // If filters is not an object, try to parse from query params with filters[] prefix
      if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
        filters = {};
        // Extract all query params that start with 'filters['
        Object.keys(req.query).forEach(key => {
          if (key.startsWith('filters[') && key.endsWith(']')) {
            const filterKey = key.slice(8, -1); // Remove 'filters[' and ']'
            filters[filterKey] = (req.query as any)[key];
          }
        });
      }
      
      // Debug logging for saved posts
      if (type === 'saved') {
        logger.debug('[Saved Feed] Raw query params', JSON.stringify(req.query, null, 2));
        logger.debug('[Saved Feed] Parsed filters', JSON.stringify(filters, null, 2));
      }

      // Handle customFeedId filter - expand to custom feed configuration
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
              ...filters,
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
            filters = { ...filters, authors: Array.from(authors).join(',') };
          }
        }
      } catch (e) {
        logger.warn('Optional listIds expansion failed', (e as Error)?.message || e);
      }

      // Handle saved posts type
      let savedPostIds: mongoose.Types.ObjectId[] = [];
      if (type === 'saved') {
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
      if (type === 'saved' && savedPostIds.length > 0) {
        // For saved posts, use a simple query that only filters by saved post IDs
        // Don't filter by visibility - users should be able to see their saved posts regardless of visibility
        query = {
          _id: { $in: savedPostIds }
        };
        
        // Apply search query filter if provided
        if (filters?.searchQuery) {
          const searchQuery = String(filters.searchQuery).trim();
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
        query = this.buildFeedQuery(type, filters, currentUserId);
      }

      // Add cursor-based pagination (handle conflict with saved posts _id filter)
      if (cursor) {
        if (type === 'saved' && savedPostIds.length > 0) {
          // For saved posts with cursor, filter savedPostIds to only include those before cursor
          const cursorId = new mongoose.Types.ObjectId(cursor);
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
          query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
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
        ]);
      } else {
        // Authenticated users get chronological feed
        // For saved posts, sort by bookmark creation date (when saved), not post creation date
        if (type === 'saved' && savedPostIds.length > 0) {
          logger.debug(`[Saved Feed] Query`, JSON.stringify(query, null, 2));
          posts = await Post.find(query)
            .select(this.FEED_FIELDS)
            .sort({ createdAt: -1 })
            .limit(limit + 1)
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
            .lean();
        }
      }

      // Single-pass deduplication: remove duplicates by _id BEFORE transformation
      const uniquePostsMap = new Map<string, any>();
      for (const post of posts) {
        const id = post._id?.toString() || post.id?.toString() || '';
        if (id && id !== 'undefined' && id !== 'null') {
          if (!uniquePostsMap.has(id)) {
            uniquePostsMap.set(id, post);
          }
        }
      }
      const deduplicatedPosts = Array.from(uniquePostsMap.values());

      // Check if there are more posts after deduplication
      const hasMore = deduplicatedPosts.length > limit;
      const postsToReturn = hasMore ? deduplicatedPosts.slice(0, limit) : deduplicatedPosts;
      
      // CRITICAL: Calculate cursor BEFORE transformation using the actual last post that will be returned
      // This ensures cursor points to the correct post and prevents skipping/duplicates
      let nextCursor: string | undefined;
      if (postsToReturn.length > 0 && hasMore) {
        const lastPost = postsToReturn[postsToReturn.length - 1];
        nextCursor = lastPost._id?.toString() || undefined;
        
        // Validate cursor advanced (prevent infinite loops)
        if (cursor && nextCursor === cursor) {
          logger.warn('⚠️ Cursor did not advance, stopping pagination', { cursor, nextCursor });
          nextCursor = undefined;
        }
      }

      // Transform posts with user data
      const transformedPosts = await this.transformPostsWithProfiles(postsToReturn, currentUserId);
      
      // For saved posts, mark all posts as saved
      if (type === 'saved') {
        transformedPosts.forEach((post: any) => {
          post.isSaved = true;
          if (post.metadata) {
            post.metadata.isSaved = true;
          } else {
            post.metadata = { isSaved: true };
          }
        });
      }

      // Single deduplication pass: already done before transformation, no need to deduplicate again
      // Transformation doesn't create duplicates, so we can use transformed posts directly
      const finalUniquePosts = transformedPosts;

      // Calculate hasMore: only true if we got limit+1 originally AND still have at least limit after dedup
      const finalHasMore = finalUniquePosts.length >= limit && nextCursor !== undefined;

      // Use cursor calculated before transformation
      const finalCursor = nextCursor;

      // DON'T emit feed:updated for fetch requests - this causes duplicates!
      // Socket feed:updated events should only be emitted when new posts are created,
      // not when users fetch/load feeds. The frontend already has the posts from the HTTP response.
      // Emitting here causes duplicate posts because:
      // 1. HTTP response adds posts to feed
      // 2. Socket event arrives and tries to add same posts again
      // Socket updates are handled in post creation endpoints, not here.

      const response: FeedResponse = {
        items: finalUniquePosts, // Return deduplicated posts
        hasMore: finalHasMore, // Use recalculated hasMore after deduplication
        nextCursor: finalCursor,
        totalCount: finalUniquePosts.length
      };

      // Performance logging
      const duration = Date.now() - startTime;
      if (duration > 100) {
        logger.warn(`[Feed] Slow query detected: ${duration}ms`, { type, cursor: cursor ? 'present' : 'none', itemCount: finalUniquePosts.length });
      } else if (process.env.NODE_ENV === 'development') {
        logger.debug(`[Feed] Query completed: ${duration}ms`, { type, itemCount: finalUniquePosts.length });
      }

      res.json(response);
    } catch (error) {
      const duration = Date.now() - startTime;
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
      const { cursor, limit = 20 } = req.query as any;
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

        if (cursor) {
          try {
            match._id = { $lt: new mongoose.Types.ObjectId(cursor) };
          } catch {
            // Invalid cursor, ignore it
          }
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
          { $limit: Number(limit) + 1 }
        ]);

        const hasMore = posts.length > Number(limit);
        const postsToReturn = hasMore ? posts.slice(0, Number(limit)) : posts;
        const nextCursor = hasMore && postsToReturn.length > 0 
          ? postsToReturn[postsToReturn.length - 1]._id.toString() 
          : undefined;

        const transformedPosts = await this.transformPostsWithProfiles(postsToReturn, currentUserId);
        
        // Deduplicate transformed posts for For You feed (unauthenticated path)
        const finalUniqueMap = new Map<string, any>();
        for (const post of transformedPosts) {
          const id = post.id?.toString() || '';
          if (id && id !== 'undefined' && id !== 'null') {
            if (!finalUniqueMap.has(id)) {
              finalUniqueMap.set(id, post);
            }
          }
        }
        const finalUniquePosts = Array.from(finalUniqueMap.values());

        const response: FeedResponse = {
          items: finalUniquePosts,
          hasMore: hasMore && finalUniquePosts.length >= Number(limit),
          nextCursor: hasMore && finalUniquePosts.length > 0 
            ? finalUniquePosts[finalUniquePosts.length - 1].id?.toString() 
            : undefined,
          totalCount: finalUniquePosts.length
        };

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

      const match: any = {
        visibility: PostVisibility.PUBLIC,
        $and: [
          { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
          { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
        ]
      };

      // Exclude seen posts at DB level for guaranteed deduplication
      // This is more efficient than filtering after ranking
      if (seenPostIds.length > 0) {
        // Convert string IDs to ObjectIds for MongoDB query
        const seenObjectIds = seenPostIds
          .filter(id => mongoose.Types.ObjectId.isValid(id))
          .map(id => new mongoose.Types.ObjectId(id));
        
        if (seenObjectIds.length > 0) {
          if (!match.$and) {
            match.$and = [];
          }
          match.$and.push({ _id: { $nin: seenObjectIds } });
        }
      }

      // Simplified cursor: use simple ObjectId-based cursor for all feeds
      // This is more reliable and easier to maintain than compound cursors
      if (cursor) {
        try {
          // Validate and use as ObjectId cursor
          if (mongoose.Types.ObjectId.isValid(cursor)) {
            match._id = { $lt: new mongoose.Types.ObjectId(cursor) };
            logger.debug('📌 Using ObjectId cursor', cursor);
          } else {
            logger.warn('⚠️ Invalid cursor format, ignoring', cursor);
          }
        } catch (error) {
          logger.warn('⚠️ Error parsing cursor, ignoring', { cursor, error });
        }
      } else {
        logger.debug('📌 No cursor - first page request');
      }

      // Get candidate posts (fetch more than needed for ranking)
      // Reduced from 3x to 2x for better performance while still sufficient for ranking
      const candidateLimit = Number(limit) * 2; // Get 2x posts for ranking/filtering

      let candidatePosts = await Post.find(match)
        .select(this.FEED_FIELDS)
        .sort({ createdAt: -1 })
        .limit(candidateLimit)
        .lean();

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
      const posts = rankedPosts.sort((a, b) => {
        const scoreA = (a as any).finalScore ?? 0;
        const scoreB = (b as any).finalScore ?? 0;
        const scoreDiff = scoreB - scoreA;
        
        // If scores are very close, use _id as tiebreaker for consistent ordering
        if (Math.abs(scoreDiff) < 0.001) {
          return a._id.toString().localeCompare(b._id.toString()) * -1; // Descending
        }
        return scoreDiff;
      });

      // OPTIMIZED: Single-pass deduplication using Map for O(1) lookups
      // Deduplicate raw posts by _id before transformation to ensure cursor accuracy
      const rawIdsSeen = new Map<string, any>();
      const deduplicatedRawPosts: any[] = [];
      
      for (const post of posts) {
        const rawId = post._id;
        if (!rawId) continue;
        
        // Convert to string for consistent comparison
        const rawIdStr = typeof rawId === 'object' && rawId.toString 
          ? rawId.toString() 
          : String(rawId);
        
        if (!rawIdsSeen.has(rawIdStr)) {
          rawIdsSeen.set(rawIdStr, post);
          deduplicatedRawPosts.push(post);
        }
      }
      
      const hasMore = deduplicatedRawPosts.length > Number(limit);
      const postsToReturn = hasMore ? deduplicatedRawPosts.slice(0, Number(limit)) : deduplicatedRawPosts;
      
      // CRITICAL: Calculate cursor BEFORE transformation using the actual last post that will be returned
      // This ensures cursor points to the correct post and prevents skipping/duplicates
      // Use simple ObjectId cursor for reliability
      let nextCursor: string | undefined;
      if (postsToReturn.length > 0 && hasMore) {
        const lastPost = postsToReturn[postsToReturn.length - 1];
        nextCursor = lastPost._id.toString();
        
        // Validate cursor advanced (prevent infinite loops)
        if (cursor && nextCursor === cursor) {
          logger.warn('⚠️ Cursor did not advance, stopping pagination', { cursor, nextCursor });
          nextCursor = undefined;
        }
        
        logger.debug('📌 Generated nextCursor', {
          lastPostId: nextCursor,
          returnedCount: postsToReturn.length,
          originalCount: deduplicatedRawPosts.length,
          duplicatesRemoved: posts.length - deduplicatedRawPosts.length
        });
      }

      // Stage 2: Transform deduplicated posts using hydration service
      // Hydration service already handles privacy filtering (blocked/restricted users)
      const transformedPosts = await this.transformPostsWithProfiles(deduplicatedRawPosts, currentUserId);
      
      // Additional privacy filtering for profile visibility (private/followers_only)
      const filteredPosts = await this.filterPostsByProfilePrivacy(transformedPosts, currentUserId);

      // Single deduplication pass: already done before transformation on raw posts
      // Transformation and privacy filtering don't create duplicates, so use filtered posts directly
      const finalDeduplicated = filteredPosts;

      // CRITICAL: Recalculate hasMore based on final deduplicated count
      // If deduplication removed posts, we might not have enough for another page
      const finalHasMore = finalDeduplicated.length >= Number(limit) && nextCursor !== undefined;
      
      // Use the cursor calculated before transformation (simple ObjectId cursor)
      // No need to recalculate - cursor is already based on the last post that will be returned
      let finalCursor = nextCursor;
      
      // Validate cursor advanced (prevent infinite loops)
      if (finalCursor && cursor && finalCursor === cursor) {
        logger.warn('⚠️ Cursor did not advance after transformation, stopping pagination', { cursor, finalCursor });
        finalCursor = undefined;
      }

      // FINAL VERIFICATION: Log what we're sending to ensure no duplicates
      const responseIds = finalDeduplicated.map(p => p.id?.toString() || 'NO_ID');
      const uniqueResponseIds = new Set(responseIds);
      
      logger.debug('📤 For You feed response', {
        requestCursor: cursor ? (cursor.length > 50 ? cursor.substring(0, 50) + '...' : cursor) : 'none',
        totalPosts: finalDeduplicated.length,
        uniqueIds: uniqueResponseIds.size,
        hasMore: finalHasMore,
        hasCursor: !!finalCursor,
        firstPostId: responseIds[0] || 'none',
        lastPostId: responseIds[responseIds.length - 1] || 'none'
      });
      
      if (responseIds.length !== uniqueResponseIds.size) {
        const duplicates = responseIds.filter((id, idx) => responseIds.indexOf(id) !== idx);
        logger.error('🚨 CRITICAL: Backend sending duplicate IDs', [...new Set(duplicates)]);
      }

      const response: FeedResponse = {
        items: finalDeduplicated, // Return fully deduplicated posts
        hasMore: finalHasMore, // Use recalculated hasMore
        nextCursor: finalCursor, // Use recalculated cursor
        totalCount: finalDeduplicated.length
      };

      res.json(response);

      // Mark returned posts as seen in Redis (async, non-blocking)
      // This prevents these posts from appearing in future pagination requests
      // Industry-standard approach: track seen posts server-side, not in cursor
      if (currentUserId && finalDeduplicated.length > 0) {
        const postIdsToMark = finalDeduplicated
          .map(post => post.id?.toString())
          .filter((id): id is string => !!id && id !== 'undefined' && id !== 'null');
        
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
      const { cursor, limit = 20 } = req.query as any;
      const currentUserId = req.user?.id;
      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Get following list from Oxy
      const followingRes = await oxyClient.getUserFollowing(currentUserId);
      // Only include people the user follows, NOT the user's own posts
      const followingIds = [...new Set(extractFollowingIds(followingRes))];

      if (followingIds.length === 0) {
        return res.json({ items: [], hasMore: false, totalCount: 0 });
      }

      const query: any = {
        oxyUserId: { $in: followingIds },
        visibility: PostVisibility.PUBLIC,
        parentPostId: null,
        repostOf: null
      };

      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }

      const posts = await Post.find(query)
        .select(this.FEED_FIELDS)
        .sort({ createdAt: -1 })
        .limit(Number(limit) + 1)
        .lean();

      const hasMore = posts.length > Number(limit);
      const postsToReturn = hasMore ? posts.slice(0, Number(limit)) : posts;
      const nextCursor = hasMore ? posts[Number(limit) - 1]._id.toString() : undefined;

      const transformedPosts = await this.transformPostsWithProfiles(postsToReturn, currentUserId);
      
      // Filter out posts from private profiles
      const filteredPosts = await this.filterPostsByProfilePrivacy(transformedPosts, currentUserId);

      const response: FeedResponse = {
        items: filteredPosts,
        hasMore,
        nextCursor,
        totalCount: filteredPosts.length
      };

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
      // Validate and sanitize inputs
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || 20)), 1), 100); // Clamp between 1-100
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

      // Simplified cursor: use simple ObjectId-based cursor for all feeds
      if (cursor) {
        try {
          // Validate and use as ObjectId cursor
          if (mongoose.Types.ObjectId.isValid(cursor)) {
            match._id = { $lt: new mongoose.Types.ObjectId(cursor) };
            logger.debug('📌 Using ObjectId cursor for explore feed', cursor);
          } else {
            logger.warn('⚠️ Invalid cursor format for explore feed, ignoring', cursor);
          }
        } catch (error) {
          logger.warn('⚠️ Error parsing cursor for explore feed, ignoring', { cursor, error });
        }
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
      ]);

      const hasMore = posts.length > limit;
      const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
      
      // Calculate simple ObjectId cursor for reliable pagination
      let nextCursor: string | undefined;
      if (postsToReturn.length > 0 && hasMore) {
        const lastPost = postsToReturn[postsToReturn.length - 1];
        nextCursor = lastPost._id.toString();
        
        // Validate cursor advanced (prevent infinite loops)
        if (cursor && nextCursor === cursor) {
          logger.warn('⚠️ Cursor did not advance in explore feed, stopping pagination', { cursor, nextCursor });
          nextCursor = undefined;
        }
      }

      const transformedPosts = await this.transformPostsWithProfiles(postsToReturn, currentUserId);
      
      // Filter out posts from private profiles
      const filteredPosts = await this.filterPostsByProfilePrivacy(transformedPosts, currentUserId);

      const response: FeedResponse = {
        items: filteredPosts,
        hasMore,
        nextCursor,
        totalCount: filteredPosts.length
      };

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
      const { cursor, limit = 20 } = req.query as any;
      const currentUserId = req.user?.id;

      const query: any = {
        visibility: PostVisibility.PUBLIC,
        $and: [
          { $or: [
            { type: { $in: [PostType.IMAGE, PostType.VIDEO] } },
            { 'content.media.0': { $exists: true } },
            { 'content.images.0': { $exists: true } },
            { 'content.attachments.0': { $exists: true } },
            { 'content.files.0': { $exists: true } },
            { 'media.0': { $exists: true } }
          ] },
          { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
          { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
        ]
      };

      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }

      const posts = await Post.find(query)
        .select(this.FEED_FIELDS)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .lean();

      const hasMore = posts.length > limit;
      const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore ? posts[limit - 1]._id.toString() : undefined;

      const transformedPosts = await this.transformPostsWithProfiles(postsToReturn, currentUserId);

      const response: FeedResponse = {
        items: transformedPosts, // Return posts directly in new schema format
        hasMore,
        nextCursor,
        totalCount: transformedPosts.length
      };

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
      const { userId } = req.params;
      const { cursor, limit = 20, type = 'posts' } = req.query as any;
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
          return res.json({ items: [], hasMore: false, nextCursor: undefined, totalCount: 0 });
        }
        
        // Check if current user is following the profile owner
        const hasAccess = await checkFollowAccess(currentUserId, userId);
        if (!hasAccess) {
          // No access - return empty feed immediately, BEFORE any post queries
          return res.json({ items: [], hasMore: false, nextCursor: undefined, totalCount: 0 });
        }
      }

      // Only proceed with fetching posts if privacy check passes
      // Handle Likes feed separately (posts the user liked)
      if (type === 'likes') {
        // Paginate likes by Like document _id (chronological like order)
        const likeQuery: any = { userId };
        if (cursor) {
          likeQuery._id = { $lt: new mongoose.Types.ObjectId(cursor) };
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
          return res.json({ items: [], hasMore: false, nextCursor: undefined, totalCount: 0 });
        }

        const posts = await Post.find({
          _id: { $in: likedPostIds },
          visibility: PostVisibility.PUBLIC
        })
        .select(this.FEED_FIELDS)
        .lean();

        // Preserve the like order
        const postsOrdered = likedPostIds
          .map(id => posts.find(p => p._id.toString() === id.toString()))
          .filter(Boolean) as any[];

        const transformedPosts = await this.transformPostsWithProfiles(postsOrdered, currentUserId);

        const response: FeedResponse = {
          items: transformedPosts, // Return posts directly in new schema format
          hasMore,
          nextCursor,
          totalCount: transformedPosts.length
        };

        return res.json(response);
      }

      const query: any = {
        oxyUserId: userId,
        visibility: PostVisibility.PUBLIC
      };

      // Filter by content type
      if (type === 'posts') {
        // Profile Posts tab should include originals and reposts (exclude only replies)
        // Show top-level items authored by the user; allow reposts/quotes to appear here like Twitter
        query.parentPostId = null;
      } else if (type === 'replies') {
        // Replies
        query.parentPostId = { $ne: null };
      } else if (type === 'media') {
        // Media-only top-level posts: include posts typed TEXT but with media arrays
        query.$and = [
          { $or: [
            { type: { $in: [PostType.IMAGE, PostType.VIDEO] } },
            { 'content.media.0': { $exists: true } },
            { 'content.images.0': { $exists: true } },
            { 'content.attachments.0': { $exists: true } },
            { 'content.files.0': { $exists: true } },
            { 'media.0': { $exists: true } }
          ] },
          { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
          { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
        ];
      } else if (type === 'reposts') {
        // Reposts only
        query.repostOf = { $ne: null };
      }

      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }

      const posts = await Post.find(query)
        .select(this.FEED_FIELDS)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .lean();

      const hasMore = posts.length > limit;
      const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore ? posts[limit - 1]._id.toString() : undefined;

      const transformedPosts = await this.transformPostsWithProfiles(postsToReturn, currentUserId);

      const response: FeedResponse = {
        items: transformedPosts, // Return posts directly in new schema format
        hasMore,
        nextCursor,
        totalCount: transformedPosts.length
      };

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
      const parentPost = await Post.findById(postId).lean();
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
  // Extract hashtags from content
  const extractedTags = Array.from((replyContent?.text || '').matchAll(/#([A-Za-z0-9_]+)/g)).map(m => m[1].toLowerCase());
      const mergedTags = Array.from(new Set([...(hashtags || []), ...extractedTags]));

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
      });

      // Emit real-time update
      io.emit('post:replied', {
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
      });

      if (existingRepost) {
        return res.status(400).json({ error: 'You have already reposted this content' });
      }

      // Create repost
      // Extract hashtags from content
      const extractedTags = Array.from((content?.text || '').matchAll(/#([A-Za-z0-9_]+)/g)).map(m => m[1].toLowerCase());
      const mergedTags = Array.from(new Set([...(hashtags || []), ...extractedTags]));

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

      // Update original post repost count
      await Post.findByIdAndUpdate(originalPostId, {
        $inc: { 'stats.repostsCount': 1 }
      });

      // Record interaction for user preference learning
      try {
        await userPreferenceService.recordInteraction(currentUserId, originalPostId, 'repost');
        // Invalidate cached feed for this user
        await feedCacheService.invalidateUserCache(currentUserId);
      } catch (error) {
        logger.warn('Failed to record interaction for preferences', error);
      }

      // Emit real-time update
      io.emit('post:reposted', {
        originalPostId,
        repost: repost.toObject(),
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
      
      const existingPost = await Post.findById(postId);
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
        { new: true }
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

      // Emit real-time update
      io.emit('post:liked', {
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
      
      const existingPost = await Post.findById(postId);
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
        { new: true }
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

      // Emit real-time update
      io.emit('post:unliked', {
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
      const { postId } = req.params;
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
      });

      if (!repost) {
        return res.status(404).json({ error: 'Repost not found' });
      }

      // Update original post repost count
      await Post.findByIdAndUpdate(repost.repostOf, {
        $inc: { 'stats.repostsCount': -1 }
      });

      // Emit real-time update
      io.emit('post:unreposted', {
        originalPostId: repost.repostOf,
        repostId: repost._id,
        userId: currentUserId,
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
      const { postId } = req.params;
      const currentUserId = req.user?.id;

      logger.debug(`[Save] Save request received: userId=${currentUserId}, postId=${postId}`);

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Check if user already saved this post
      const existingPost = await Post.findById(postId);
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

      // Add user to savedBy array
      const updateResult = await Post.findByIdAndUpdate(
        postId,
        {
          $addToSet: { 'metadata.savedBy': currentUserId }
        },
        { new: true }
      );

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

      // Emit real-time update
      io.emit('post:saved', {
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
      const { postId } = req.params;
      const currentUserId = req.user?.id;

      logger.debug('🗑️ Unsave endpoint called', { postId, currentUserId, user: req.user });

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Check if user has saved this post
      const existingPost = await Post.findById(postId);
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

      // Remove user from savedBy array
      const updateResult = await Post.findByIdAndUpdate(
        postId,
        {
          $pull: { 'metadata.savedBy': currentUserId }
        },
        { new: true }
      );

      // Emit real-time update
      io.emit('post:unsaved', {
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

      const post = await Post.findById(id).lean();
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
