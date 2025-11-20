import { Request, Response, NextFunction } from 'express';
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
  Post as DomainPost,
  PostType,
  PostVisibility
} from '@mention/shared-types';
import mongoose from 'mongoose';
import { io } from '../../server';
import { oxy as oxyClient } from '../../server';
import { feedRankingService } from '../services/FeedRankingService';
import { feedCacheService } from '../services/FeedCacheService';
import { userPreferenceService } from '../services/UserPreferenceService';
import UserBehavior from '../models/UserBehavior';
import UserSettings from '../models/UserSettings';

interface AuthRequest extends Request {
  user?: {
    id: string;
    [key: string]: any;
  };
}

class FeedController {
  /**
   * Filter out posts from private/followers_only profiles that the viewer doesn't have access to
   */
  private async filterPostsByProfilePrivacy(
    posts: any[],
    currentUserId?: string
  ): Promise<any[]> {
    if (!posts || posts.length === 0) return posts;
    
    // Get unique author IDs
    const authorIds = [...new Set(posts.map(p => p.oxyUserId).filter(Boolean))];
    if (authorIds.length === 0) return posts;
    
    // Get privacy settings for all authors
    const privacySettings = await UserSettings.find({
      oxyUserId: { $in: authorIds },
      'privacy.profileVisibility': { $in: ['private', 'followers_only'] }
    }).lean();
    
    const privateProfileIds = new Set(
      privacySettings.map(s => s.oxyUserId)
    );
    
    if (privateProfileIds.size === 0) return posts; // No private profiles
    
    // If no current user, filter out all posts from private profiles
    if (!currentUserId) {
      return posts.filter(p => !privateProfileIds.has(p.oxyUserId));
    }
    
    // Get following list for current user
    let followingIds: string[] = [];
    try {
      const followingRes = await oxyClient.getUserFollowing(currentUserId);
      const followingList = Array.isArray((followingRes as any)?.following)
        ? (followingRes as any).following
        : (Array.isArray(followingRes) ? followingRes : []);
      followingIds = followingList.map((u: any) => 
        typeof u === 'string' ? u : (u?.id || u?._id || u?.userId || u?.user?.id || u?.profile?.id || u?.targetId)
      ).filter(Boolean);
    } catch (error) {
      console.error('Error getting following list for privacy filter:', error);
      // On error, filter out private profiles for safety
      return posts.filter(p => !privateProfileIds.has(p.oxyUserId));
    }
    
    // Filter posts: keep if:
    // - Author profile is not private
    // - Author is the current user (own posts)
    // - Current user is following the author (for followers_only)
    return posts.filter(p => {
      const authorId = p.oxyUserId;
      if (!privateProfileIds.has(authorId)) return true; // Public profile
      if (authorId === currentUserId) return true; // Own posts
      return followingIds.includes(authorId); // Following the author
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
        console.error(`Error fetching user data for mention ${userId}:`, error);
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
  private async transformPostsWithProfiles(posts: any[], currentUserId?: string): Promise<any[]> {
    try {
      // First, populate poll data for posts that have polls
      const postsWithPolls = await this.populatePollData(posts);
      // Collect any referenced original/quoted posts to resolve their media and embed originals
      const originalIds = Array.from(new Set(
        postsWithPolls
          .map((p: any) => {
            const obj = p.toObject ? p.toObject() : p;
            return obj.repostOf || obj.quoteOf;
          })
          .filter(Boolean)
          .map((id: any) => id.toString())
      ));

      const originalsMap = new Map<string, any>();
      if (originalIds.length) {
        try {
          const originals = await Post.find({ _id: { $in: originalIds } })
            .select('_id oxyUserId type content visibility stats metadata createdAt updatedAt repostOf quoteOf parentPostId threadId tags mentions hashtags media')
            .lean();
          originals.forEach((op: any) => originalsMap.set(op._id.toString(), op));
        } catch (e) {
          console.warn('Failed fetching originals for media aggregation:', e);
        }
      }
      
      // Get unique user IDs to fetch user data in batch, include original authors
      const userIds = [...new Set([
        ...postsWithPolls.map(post => {
          const postObj = post.toObject ? post.toObject() : post;
          return postObj.oxyUserId;
        }),
        ...Array.from(originalsMap.values()).map((op: any) => op?.oxyUserId).filter(Boolean)
      ])];

      // Fetch user data from Oxy in parallel
      const userDataMap = new Map();
      await Promise.all(userIds.map(async (userId) => {
        try {
          if (userId) {
            const userData = await oxyClient.getUserById(userId);
            userDataMap.set(userId, {
              id: userData.id,
              name: userData.name?.full || userData.username,
              handle: userData.username,
              avatar: typeof userData.avatar === 'string' ? userData.avatar : (userData.avatar as any)?.url || '',
              verified: userData.verified || false
            });
          }
        } catch (error) {
          console.error(`Error fetching user data for ${userId}:`, error);
          // Fallback user data
          userDataMap.set(userId, {
            id: userId,
            name: 'User',
            handle: 'user',
            avatar: '',
            verified: false
          });
        }
      }));

      // Get user interaction data for current user if authenticated
      const userInteractions = new Map();
      if (currentUserId) {
        try {
          // Get all post IDs
          const postIds = postsWithPolls.map(post => {
            const postObj = post.toObject ? post.toObject() : post;
            return postObj._id.toString();
          });

          // Use Like collection to check if current user liked posts (more efficient than storing full array)
          // This avoids loading metadata.likedBy arrays which can be huge for popular posts
          const userLikes = await Like.find({
            userId: currentUserId,
            postId: { $in: postIds }
          }).select('postId').lean();

          const likedPostIds = new Set(
            userLikes.map((like: any) => like.postId?.toString?.()).filter(Boolean)
          );

          // Check saves using Bookmark collection (also more efficient)
          const userBookmarks = await Bookmark.find({
            userId: currentUserId,
            postId: { $in: postIds }
          }).select('postId').lean();

          const savedPostIds = new Set(
            userBookmarks.map((bookmark: any) => bookmark.postId?.toString?.()).filter(Boolean)
          );

          // Set user interactions based on Like/Bookmark collections
          postIds.forEach(postId => {
            const interactions: any = {};
            if (likedPostIds.has(postId)) {
              interactions.isLiked = true;
            }
            if (savedPostIds.has(postId)) {
              interactions.isSaved = true;
            }
            if (Object.keys(interactions).length > 0) {
              userInteractions.set(postId, interactions);
            }
          });

          // Check reposts for current user
          const repostedPosts = await Post.find({
            oxyUserId: currentUserId,
            repostOf: { $in: postIds }
          }).select('repostOf');

          repostedPosts.forEach(post => {
            userInteractions.set(post.repostOf, {
              ...userInteractions.get(post.repostOf),
              isReposted: true
            });
          });
        } catch (error) {
          console.error('Error fetching user interactions:', error);
        }
      }

      // Check which posts are threads (have replies from the same user)
      const threadStatusMap = new Map();
      try {
        const postIds = postsWithPolls.map(post => {
          const postObj = post.toObject ? post.toObject() : post;
          return postObj._id.toString();
        });

        const threadChecks = await Promise.all(postIds.map(async (postId) => {
          const postObj = postsWithPolls.find(p => {
            const obj = p.toObject ? p.toObject() : p;
            return obj._id.toString() === postId;
          });
          
          if (postObj) {
            const obj = postObj.toObject ? postObj.toObject() : postObj;
            const repliesFromSameUser = await Post.findOne({
              parentPostId: postId,
              oxyUserId: obj.oxyUserId
            }).lean();
            
            return { postId, isThread: !!repliesFromSameUser };
          }
          return { postId, isThread: false };
        }));

        threadChecks.forEach(({ postId, isThread }) => {
          threadStatusMap.set(postId, isThread);
        });
      } catch (error) {
        console.error('Error checking thread status:', error);
      }

      // Helper to extract media ids from any raw post-like object
      const extractMediaIds = (obj: any): string[] => {
        if (!obj) return [];
        const out: string[] = [];
        const pushFrom = (arr?: any[]) => {
          if (!Array.isArray(arr) || !arr.length) return;
          arr.forEach((m: any) => {
            if (!m) return;
            if (typeof m === 'string') {
              out.push(m);
            } else if (typeof m === 'object') {
              const id = m.id || m.url || m.src || m.path;
              if (id) out.push(String(id));
            }
          });
        };
        pushFrom(obj?.content?.media);
        pushFrom((obj as any)?.content?.images);
        pushFrom((obj as any)?.content?.attachments);
        pushFrom((obj as any)?.content?.files);
        pushFrom((obj as any)?.media); // legacy
        // unique preserve order
        const seen = new Set<string>();
        return out.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
      };

      // Helper to build a minimal transformed post for embedding (no nested originals)
      const buildEmbedded = async (obj: any) => {
        if (!obj) return undefined;
        const oid = obj._id?.toString?.() || String(obj._id || obj.id);
        const u = userDataMap.get(obj.oxyUserId) || {
          id: obj.oxyUserId,
          name: 'User',
          handle: 'user',
          avatar: '',
          verified: false
        };
        const stats = obj.stats || { likesCount: 0, repostsCount: 0, commentsCount: 0, viewsCount: 0, sharesCount: 0 };
        const engagement = {
          replies: stats.commentsCount || 0,
          reposts: stats.repostsCount || 0,
          likes: stats.likesCount || 0
        };
        const mediaIds = extractMediaIds(obj);
        
        // Replace mention placeholders in embedded post content
        const embeddedContentText = obj.content?.text || '';
        const embeddedReplacedText = await this.replaceMentionPlaceholders(embeddedContentText, obj.mentions || []);
        
        return {
          id: oid,
          _id: obj._id,
          oxyUserId: obj.oxyUserId,
          type: obj.type,
          content: {
            ...obj.content,
            text: embeddedReplacedText
          },
          visibility: obj.visibility,
          isEdited: obj.isEdited,
          editHistory: obj.editHistory,
          language: obj.language,
          tags: obj.tags || [],
          mentions: obj.mentions || [],
          hashtags: obj.hashtags || [],
          repostOf: obj.repostOf,
          quoteOf: obj.quoteOf,
          parentPostId: obj.parentPostId,
          threadId: obj.threadId,
          stats,
          // Don't include likedBy/savedBy arrays in response (too much data)
          // Only include isLiked/isSaved flags which are set from userInteractions map
          metadata: (() => {
            const md = obj.metadata || {};
            // Remove likedBy/savedBy arrays to reduce payload size
            const { likedBy, savedBy, ...cleanMetadata } = md;
            return cleanMetadata;
          })(),
          createdAt: obj.createdAt,
          updatedAt: obj.updatedAt,
          date: obj.createdAt,
          user: u,
          engagement,
          mediaIds
        };
      };

      // Transform posts with real user data and engagement stats
      const transformedPosts = await Promise.all(postsWithPolls.map(async post => {
        const postObj = post.toObject ? post.toObject() : post;
        const userId = postObj.oxyUserId;
        const postId = postObj._id.toString();
        const userData = userDataMap.get(userId) || {
          id: userId,
          name: 'User',
          handle: 'user',
          avatar: '',
          verified: false
        };

        // Calculate engagement stats from actual database values
        // Ensure stats object exists with default values if not present
        const stats = postObj.stats || {
          likesCount: 0,
          repostsCount: 0, 
          commentsCount: 0,
          viewsCount: 0,
          sharesCount: 0
        };
        
        const engagement = {
          replies: stats.commentsCount || 0,
          reposts: stats.repostsCount || 0,
          likes: stats.likesCount || 0
        };

        // Get user-specific interaction flags
        const interactions = userInteractions.get(postId) || {};
        const isLiked = Boolean(interactions.isLiked);
        const isReposted = Boolean(interactions.isReposted);
        const isSaved = Boolean(interactions.isSaved);
        const isThread = threadStatusMap.get(postId) || false;

        // Media aggregation for this post and its original/quoted if applicable
        const mediaIds = extractMediaIds(postObj);
  const originalRef = postObj.repostOf || postObj.quoteOf;
  const originalObj = originalRef ? originalsMap.get(originalRef.toString()) : undefined;
        const originalMediaIds = extractMediaIds(originalObj);
        const allMediaIds = (() => {
          const seen = new Set<string>();
          const merged = [...mediaIds, ...originalMediaIds];
          return merged.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
        })();

        // Optionally embed original/quoted post
        const embeddedOriginal = originalObj ? await buildEmbedded(originalObj) : undefined;

        // Build lightweight actor label for reposts
        const repostedBy = postObj.repostOf ? {
          id: userData.id,
          name: userData.name,
          handle: userData.handle,
          avatar: userData.avatar,
          verified: userData.verified,
          date: postObj.createdAt,
        } : undefined;

        // Replace mention placeholders in post content text
        const contentText = postObj.content?.text || '';
        const mentionsArray = postObj.mentions || [];
        if (mentionsArray.length > 0 && contentText.includes('[mention:')) {
          console.log(`[Feed Transform] Processing mentions for post ${postId}:`, mentionsArray);
          console.log(`[Feed Transform] Content before:`, contentText.substring(0, 100));
        }
        const replacedText = await this.replaceMentionPlaceholders(contentText, mentionsArray);
        if (mentionsArray.length > 0 && contentText.includes('[mention:') && replacedText !== contentText) {
          console.log(`[Feed Transform] Content after:`, replacedText.substring(0, 100));
        }

        // Return post in standard Post schema format
        const transformedPost = {
          id: postId,
          _id: postObj._id,
          oxyUserId: postObj.oxyUserId,
          type: postObj.type,
          content: {
            ...postObj.content,
            text: replacedText
          }, // Return complete content structure with replaced mentions
          visibility: postObj.visibility,
          isEdited: postObj.isEdited,
          editHistory: postObj.editHistory,
          language: postObj.language,
          tags: postObj.tags || [],
          mentions: postObj.mentions || [],
          hashtags: postObj.hashtags || [],
          repostOf: postObj.repostOf,
          quoteOf: postObj.quoteOf,
          parentPostId: postObj.parentPostId,
          threadId: postObj.threadId,
          replyPermission: postObj.replyPermission,
          reviewReplies: postObj.reviewReplies,
          stats: stats, // Use the processed stats object
          metadata: {
            ...postObj.metadata,
            isLiked,
            isReposted,
            isSaved,
          },
          // Set top-level flags for easier frontend access (preferred by frontend)
          isLiked,
          isReposted,
          isSaved,
          location: postObj.location, // Post creation location metadata
          createdAt: postObj.createdAt,
          updatedAt: postObj.updatedAt,
          // Additional fields for UI compatibility
          date: postObj.createdAt, // Frontend expects 'date' field
          user: userData,
          engagement,
          isThread,
          // Normalized media fields for clients
          mediaIds,
          originalMediaIds,
          allMediaIds,
          // Embed original/quoted to avoid extra client roundtrips
          ...(postObj.repostOf ? { original: embeddedOriginal } : {}),
          ...(postObj.quoteOf ? { quoted: embeddedOriginal } : {}),
          ...(repostedBy ? { repostedBy } : {})
        };

        return transformedPost;
      }));

      return transformedPosts;
    } catch (error) {
      console.error('Error transforming posts:', error);
      throw new Error('Failed to transform posts');
    }
  }

  /**
   * Build query based on feed type and filters
   */
  private buildFeedQuery(type: FeedType, filters?: any, currentUserId?: string): any {
    const query: any = {
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
      console.error('Error populating poll data:', error);
      return posts; // Return posts without poll data if population fails
    }
  }

  /**
   * Get main feed with pagination and real-time updates
   */
  async getFeed(req: AuthRequest, res: Response) {
    try {
      const { type = 'mixed', cursor, limit = 20 } = req.query as any;
      let filters: any = req.query.filters as any;
      const currentUserId = req.user?.id;

      // Parse filters - Express should parse filters[searchQuery]=value automatically
      // But handle cases where it might be a string or need manual parsing
      if (typeof filters === 'string') {
        try {
          filters = JSON.parse(filters);
        } catch (e) {
          console.warn('Failed to parse filters JSON:', e);
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
        console.log('[Saved Feed] Raw query params:', JSON.stringify(req.query, null, 2));
        console.log('[Saved Feed] Parsed filters:', JSON.stringify(filters, null, 2));
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
              console.warn('Failed to expand feed.sourceListIds:', (e as Error)?.message || e);
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
        console.warn('Optional customFeedId expansion failed:', (e as Error)?.message || e);
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
        console.warn('Optional listIds expansion failed:', (e as Error)?.message || e);
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
            console.error('Invalid postId in bookmark:', saved.postId, e);
            return null;
          }
        }).filter((id): id is mongoose.Types.ObjectId => id !== null);
        
        console.log(`[Saved Feed] Found ${savedPostIds.length} saved posts for user ${currentUserId}`);
        
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
          console.log(`[Saved Feed] Applying search filter: "${searchQuery}"`);
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
        
        console.log(`[Saved Feed] Final query:`, JSON.stringify(query, null, 2));
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
          console.log(`[Saved Feed] Query:`, JSON.stringify(query, null, 2));
          posts = await Post.find(query)
            .sort({ createdAt: -1 })
            .limit(limit + 1)
            .lean();
          console.log(`[Saved Feed] Found ${posts.length} posts matching query`);
          // Log mentions for debugging
          if (posts.length > 0) {
            const samplePost = posts[0];
            console.log(`[Saved Feed] Sample post mentions:`, samplePost?.mentions);
            console.log(`[Saved Feed] Sample post content.text:`, samplePost?.content?.text?.substring(0, 100));
          }
        } else {
          posts = await Post.find(query)
            .sort({ createdAt: -1 })
            .limit(limit + 1)
            .lean();
        }
      }

      // Check if there are more posts
      const hasMore = posts.length > limit;
      const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
      
      // Single-pass deduplication: remove duplicates by _id
      const uniquePostsMap = new Map<string, any>();
      for (const post of postsToReturn) {
        const id = post._id?.toString() || post.id?.toString() || '';
        if (id && id !== 'undefined' && id !== 'null') {
          if (!uniquePostsMap.has(id)) {
            uniquePostsMap.set(id, post);
          }
        }
      }
      const deduplicatedPosts = Array.from(uniquePostsMap.values());

      // Transform posts with user data
      const transformedPosts = await this.transformPostsWithProfiles(deduplicatedPosts, currentUserId);
      
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

      // Final deduplication after transformation (ensures no duplicates in response)
      const finalUniqueMap = new Map<string, any>();
      for (const post of transformedPosts) {
        const id = post.id?.toString() || post._id?.toString() || '';
        if (id && id !== 'undefined' && id !== 'null') {
          if (!finalUniqueMap.has(id)) {
            finalUniqueMap.set(id, post);
          }
        }
      }
      const finalUniquePosts = Array.from(finalUniqueMap.values());

      // Calculate hasMore: only true if we got limit+1 originally AND still have at least limit after dedup
      const finalHasMore = hasMore && finalUniquePosts.length >= limit;

      // Calculate cursor from the last post in the deduplicated array
      const finalCursor = finalHasMore && finalUniquePosts.length > 0 
        ? (finalUniquePosts[finalUniquePosts.length - 1].id?.toString() || 
           finalUniquePosts[finalUniquePosts.length - 1]._id?.toString() || 
           undefined)
        : undefined;

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

      res.json(response);
    } catch (error) {
      console.error('Error fetching feed:', error);
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
          const id = post.id?.toString() || post._id?.toString() || '';
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
            ? finalUniquePosts[finalUniquePosts.length - 1]._id?.toString() 
            : undefined,
          totalCount: finalUniquePosts.length
        };

        return res.json(response);
      }

      // Use advanced feed ranking service for authenticated users
      // Get following list and user behavior for personalization
      let followingIds: string[] = [];
      let userBehavior: any = null;
      
      try {
        if (currentUserId) {
          // Get following list
          const followingRes = await oxyClient.getUserFollowing(currentUserId);
          const followingUsers = (followingRes as any)?.following || [];
          followingIds = followingUsers.map((u: any) => 
            typeof u === 'string' ? u : (u?.id || u?._id || u?.userId)
          ).filter(Boolean);
          
          // Get user behavior for personalization
          userBehavior = await UserBehavior.findOne({ oxyUserId: currentUserId }).lean();
        }
      } catch (e) {
        console.error('ForYou: Failed to load user data; continuing with basic ranking', e);
      }

      const match: any = {
        visibility: PostVisibility.PUBLIC,
        $and: [
          { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
          { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
        ]
      };

      let cursorId: string | undefined;
      let minFinalScore: number | undefined;
      
      // Parse cursor - supports both compound (base64 JSON) and simple ObjectId format
      if (cursor) {
        try {
          // Try to decode as base64 JSON (compound cursor)
          const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
          const parsed = JSON.parse(decoded);
          if (parsed._id && typeof parsed.minScore === 'number') {
            cursorId = parsed._id;
            minFinalScore = parsed.minScore;
            // IMPORTANT: Don't filter by _id in initial match when using compound cursor
            // We'll filter by both score and _id together later to prevent duplicates
            console.log('📌 Parsed compound cursor:', { cursorId, minFinalScore });
          } else {
            throw new Error('Invalid compound cursor structure');
          }
        } catch {
          // Not a compound cursor, treat as simple ObjectId (backward compatible)
          // For simple cursors, we'll only filter by _id (older behavior)
          try {
            // Validate it's a valid ObjectId
            new mongoose.Types.ObjectId(cursor);
            cursorId = cursor;
            // Apply _id filter for simple cursor-based pagination
            match._id = { $lt: new mongoose.Types.ObjectId(cursorId) };
            console.log('📌 Using simple cursor:', cursorId);
          } catch {
            // Invalid cursor format, ignore it
            console.warn('⚠️ Invalid cursor format:', cursor);
          }
        }
      } else {
        console.log('📌 No cursor - first page request');
      }

      // Get candidate posts (fetch more than needed for ranking)
      const candidateLimit = Number(limit) * 3; // Get 3x posts for ranking/filtering
      
      // Apply cursor pagination to initial query if using simple cursor
      if (cursorId && minFinalScore === undefined) {
        match._id = { $lt: new mongoose.Types.ObjectId(cursorId) };
      }

      let candidatePosts = await Post.find(match)
        .sort({ createdAt: -1 })
        .limit(candidateLimit)
        .lean();

      // Use advanced ranking service to rank and sort posts
      const rankedPosts = await feedRankingService.rankPosts(
        candidatePosts,
        currentUserId,
        {
          followingIds,
          userBehavior
        }
      );

      // Apply compound cursor filtering if using advanced cursor
      let posts = rankedPosts;
      if (minFinalScore !== undefined && cursorId) {
        // Filter by score and _id for compound cursor
        const postsWithScores = await Promise.all(
          rankedPosts.map(async (post) => {
            const score = await feedRankingService.calculatePostScore(
              post,
              currentUserId,
              { followingIds, userBehavior }
            );
            return { post, score };
          })
        );

        // Filter out posts that appeared on previous page
        posts = postsWithScores
          .filter(({ post, score }) => {
            const postId = post._id.toString();
            // Include posts with lower score, or same score but lower _id
            return score < minFinalScore! || 
              (score === minFinalScore && postId < cursorId);
          })
          .map(item => item.post);

        // Re-sort after filtering
        posts = await feedRankingService.rankPosts(
          posts,
          currentUserId,
          { followingIds, userBehavior }
        );
      }

      const hasMore = posts.length > Number(limit);
      const postsToReturn = hasMore ? posts.slice(0, Number(limit)) : posts;

      // CRITICAL: Multi-stage deduplication to ensure no duplicates
      // Stage 1: Deduplicate raw posts by _id (MongoDB ObjectId) before transformation
      // This MUST happen before cursor calculation to ensure cursor points to actual last post
      const rawIdsSeen = new Map<string, any>();
      const deduplicatedRawPosts = postsToReturn.filter((post: any) => {
        const rawId = post._id;
        if (!rawId) return false;
        
        // Convert to string for consistent comparison
        const rawIdStr = typeof rawId === 'object' && rawId.toString 
          ? rawId.toString() 
          : String(rawId);
        
        if (rawIdsSeen.has(rawIdStr)) {
          return false; // Duplicate _id
        }
        rawIdsSeen.set(rawIdStr, post);
        return true;
      });
      
      // CRITICAL: Calculate cursor AFTER deduplication using the actual last post that will be returned
      // This ensures cursor points to the correct post and prevents skipping/duplicates
      let nextCursor: string | undefined;
      if (deduplicatedRawPosts.length > 0) {
        const lastPost = deduplicatedRawPosts[deduplicatedRawPosts.length - 1];
        
        // Calculate final score for last post
        const lastPostScore = await feedRankingService.calculatePostScore(
          lastPost,
          currentUserId,
          { followingIds, userBehavior }
        );
        
        // Encode as compound cursor (score + _id) for engagement-based feeds
        const cursorData = {
          _id: lastPost._id.toString(),
          minScore: lastPostScore
        };
        nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
        
        // Log cursor for debugging
        console.log('📌 Generated nextCursor (after dedup):', {
          lastPostId: lastPost._id.toString(),
          lastPostScore,
          nextCursor: nextCursor.substring(0, 30) + '...',
          returnedCount: deduplicatedRawPosts.length,
          originalCount: postsToReturn.length,
          duplicatesRemoved: postsToReturn.length - deduplicatedRawPosts.length
        });
      }

      // Stage 2: Transform deduplicated posts
      const transformedPosts = await this.transformPostsWithProfiles(deduplicatedRawPosts, currentUserId);
      
      // Filter out posts from private profiles
      const filteredPosts = await this.filterPostsByProfilePrivacy(transformedPosts, currentUserId);

      // Stage 3: Deduplicate transformed posts by id (defensive check)
      const transformedIdsSeen = new Map<string, any>();
      const deduplicatedPosts = filteredPosts.filter(post => {
        // Check both id and _id fields for robustness
        const id1 = post.id ? String(post.id) : null;
        const id2 = (post as any)._id 
          ? (typeof (post as any)._id === 'object' && (post as any)._id.toString 
             ? (post as any)._id.toString() 
             : String((post as any)._id))
          : null;
        
        const primaryId = id1 || id2;
        if (!primaryId) return false;
        
        if (transformedIdsSeen.has(primaryId)) {
          return false; // Duplicate id
        }
        transformedIdsSeen.set(primaryId, post);
        return true;
      });

      // Debug: Comprehensive duplicate detection and logging (temporary for diagnosis)
      const postIdsInResponse = deduplicatedPosts.map(p => {
        const id = p.id || (p as any)._id?.toString();
        return id ? String(id) : null;
      }).filter(Boolean) as string[];
      
      const uniqueIdsInResponse = new Set(postIdsInResponse);
      
      // Check for duplicates at multiple stages
      const rawPostIds = postsToReturn.map((p: any) => p._id?.toString()).filter(Boolean);
      const uniqueRawIds = new Set(rawPostIds);
      
      // Log detailed information for debugging duplicates
      if (rawPostIds.length !== uniqueRawIds.size || postIdsInResponse.length !== uniqueIdsInResponse.size) {
        const duplicates = rawPostIds.filter((id, index) => rawPostIds.indexOf(id) !== index);
        const finalDuplicates = postIdsInResponse.filter((id, index) => postIdsInResponse.indexOf(id) !== index);
        
        console.error('⚠️ DUPLICATES DETECTED in For You feed:', {
          stage: 'raw',
          rawTotal: rawPostIds.length,
          rawUnique: uniqueRawIds.size,
          rawDuplicates: duplicates,
          stage2: 'transformed',
          finalTotal: postIdsInResponse.length,
          finalUnique: uniqueIdsInResponse.size,
          finalDuplicates: finalDuplicates,
          cursor: cursor ? (cursor.length > 50 ? cursor.substring(0, 50) + '...' : cursor) : 'none',
          parsedCursor: cursorId ? { cursorId, minFinalScore } : 'none',
          returnedCount: deduplicatedPosts.length
        });
      }

      // FINAL SAFETY CHECK: Ensure no duplicates in response
      const finalUniqueIds = new Map<string, any>();
      const finalDeduplicated = deduplicatedPosts.filter(post => {
        // Normalize ID consistently
        let normalizedId = '';
        if (post.id) {
          normalizedId = String(post.id);
        } else if ((post as any)._id) {
          const _id = (post as any)._id;
          normalizedId = typeof _id === 'object' && _id.toString 
            ? _id.toString() 
            : String(_id);
        }
        
        if (!normalizedId || normalizedId === 'undefined' || normalizedId === 'null' || normalizedId === '') {
          return false;
        }
        
        if (finalUniqueIds.has(normalizedId)) {
          const existing = finalUniqueIds.get(normalizedId);
          console.error('⚠️ FINAL backend response: Duplicate ID detected and removed:', {
            id: normalizedId,
            existing: { id: existing?.id || existing?._id, content: existing?.content?.text?.substring(0, 50) },
            duplicate: { id: post?.id || post?._id, content: post?.content?.text?.substring(0, 50) }
          });
          return false;
        }
        finalUniqueIds.set(normalizedId, post);
        return true;
      });

      // Log if final deduplication removed any posts
      if (finalDeduplicated.length !== deduplicatedPosts.length) {
        const duplicateIds = deduplicatedPosts
          .map(p => {
            const id = p.id ? String(p.id) : '';
            const _id = (p as any)._id ? String((p as any)._id) : '';
            return id || _id;
          })
          .filter((id, index, arr) => arr.indexOf(id) !== index);
        
        console.error('⚠️ FINAL deduplication removed duplicates:', {
          before: deduplicatedPosts.length,
          after: finalDeduplicated.length,
          removed: deduplicatedPosts.length - finalDeduplicated.length,
          duplicateIds: [...new Set(duplicateIds)].slice(0, 10)
        });
      }

      // CRITICAL: Verify absolute uniqueness before sending response
      const allReturnedIds = finalDeduplicated.map(p => {
        const id = p.id ? String(p.id) : '';
        const _id = (p as any)._id ? String((p as any)._id) : '';
        return id || _id || 'NO_ID';
      });
      const uniqueReturnedIds = new Set(allReturnedIds);
      
      if (allReturnedIds.length !== uniqueReturnedIds.size) {
        const duplicates = allReturnedIds.filter((id, idx) => allReturnedIds.indexOf(id) !== idx);
        console.error('⚠️ CRITICAL: Backend response STILL has duplicate IDs after all deduplication!', {
          total: allReturnedIds.length,
          unique: uniqueReturnedIds.size,
          duplicates: [...new Set(duplicates)].slice(0, 10),
          allIds: allReturnedIds
        });
        
        // Force deduplication one more time as emergency fallback
        const emergencyUnique = new Map<string, any>();
        for (const post of finalDeduplicated) {
          const id = post.id ? String(post.id) : ((post as any)._id ? String((post as any)._id) : '');
          if (id && id !== 'NO_ID' && !emergencyUnique.has(id)) {
            emergencyUnique.set(id, post);
          }
        }
        finalDeduplicated.length = 0;
        finalDeduplicated.push(...emergencyUnique.values());
        
        console.error('Deduplication mismatch detected:', {
          before: allReturnedIds.length,
          after: finalDeduplicated.length
        });
      }

      // CRITICAL: Recalculate hasMore based on deduplicated count
      // If deduplication removed posts, we might not have enough for another page
      const finalHasMore = hasMore && finalDeduplicated.length >= Number(limit);
      
      // CRITICAL: Recalculate cursor from final deduplicated posts to ensure accuracy
      // If the last post changed due to deduplication, cursor needs to be updated
      let finalCursor = nextCursor;
      if (finalHasMore && finalDeduplicated.length > 0) {
        const actualLastPost = finalDeduplicated[finalDeduplicated.length - 1];
        const actualLastPostRaw = deduplicatedRawPosts.find((p: any) => {
          const rawId = p._id?.toString();
          const postId = actualLastPost.id?.toString() || (actualLastPost as any)._id?.toString();
          return rawId === postId;
        });
        
        if (actualLastPostRaw) {
          // Parse original cursor to compare
          let originalCursorId: string | undefined;
          try {
            if (nextCursor) {
              const decoded = Buffer.from(nextCursor, 'base64').toString('utf-8');
              const parsed = JSON.parse(decoded);
              originalCursorId = parsed._id;
            }
          } catch (e) {
            // Cursor parsing failed, ignore
          }
          
          const actualLastPostId = actualLastPostRaw._id?.toString();
          
          // If last post changed due to deduplication, recalculate cursor
          if (actualLastPostId && actualLastPostId !== originalCursorId) {
            const actualLastPostScore = await feedRankingService.calculatePostScore(
              actualLastPostRaw,
              currentUserId,
              { followingIds, userBehavior }
            );
            const cursorData = {
              _id: actualLastPostId,
              minScore: actualLastPostScore
            };
            finalCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
            console.log('📌 Cursor recalculated due to deduplication:', {
              originalLastPostId: originalCursorId || 'none',
              newLastPostId: actualLastPostId
            });
          }
        }
      } else if (!finalHasMore) {
        // No more posts, clear cursor
        finalCursor = undefined;
      }

      // FINAL VERIFICATION: Log what we're sending to ensure no duplicates
      const responseIds = finalDeduplicated.map(p => p.id?.toString() || (p as any)._id?.toString() || 'NO_ID');
      const uniqueResponseIds = new Set(responseIds);
      
      console.log('📤 For You feed response:', {
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
        console.error('🚨 CRITICAL: Backend sending duplicate IDs:', [...new Set(duplicates)]);
      }

      const response: FeedResponse = {
        items: finalDeduplicated, // Return fully deduplicated posts
        hasMore: finalHasMore, // Use recalculated hasMore
        nextCursor: finalCursor, // Use recalculated cursor
        totalCount: finalDeduplicated.length
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching For You feed:', error);
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
      const rawList = Array.isArray((followingRes as any)?.following)
        ? (followingRes as any).following
        : (Array.isArray(followingRes) ? (followingRes as any) : []);
      const extracted = (rawList as any[]).map((u: any) => (
        typeof u === 'string' 
          ? u 
          : (u?.id || u?._id || u?.userId || u?.user?.id || u?.profile?.id || u?.targetId)
      ));
      // Only include people the user follows, NOT the user's own posts
      const followingIds = [...new Set(extracted.filter(Boolean))];

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
      console.error('Error fetching Following feed:', error);
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

      let cursorId: string | undefined;
      let minFinalScore: number | undefined;
      
      // Parse cursor - supports both compound (base64 JSON) and simple ObjectId format
      if (cursor) {
        try {
          // Try to decode as base64 JSON (compound cursor)
          const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
          const parsed = JSON.parse(decoded);
          if (parsed._id && typeof parsed.minScore === 'number') {
            cursorId = parsed._id;
            minFinalScore = parsed.minScore;
          } else {
            throw new Error('Invalid compound cursor structure');
          }
        } catch {
          // Not a compound cursor, treat as simple ObjectId (backward compatible)
          // Validate ObjectId format to prevent injection
          if (mongoose.Types.ObjectId.isValid(cursor)) {
            try {
              cursorId = cursor;
              match._id = { $lt: new mongoose.Types.ObjectId(cursorId) };
            } catch {
              // Invalid ObjectId - ignore and continue without cursor
            }
          }
        }
      }

      // Calculate trending score based on raw engagement metrics
      // Prioritize: likes, replies, reposts, saves, views
      // Use insights for quality filtering but prioritize total engagement
      const posts = await Post.aggregate([
        { $match: match },
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
        // Apply cursor filtering
        ...(minFinalScore !== undefined && cursorId ? [{
          $match: {
            $or: [
              { trendingScore: { $lt: minFinalScore } },
              {
                $and: [
                  { trendingScore: minFinalScore },
                  // Validate ObjectId to prevent injection
                  { _id: mongoose.Types.ObjectId.isValid(cursorId) ? { $lt: new mongoose.Types.ObjectId(cursorId) } : { $exists: false } }
                ]
              }
            ]
          }
        }] : []),
        // Sort by trending score (highest first), then by _id for consistent ordering
        { $sort: { trendingScore: -1, _id: -1 } },
        { $limit: limit + 1 }
      ]);

      const hasMore = posts.length > limit;
      const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
      
      // Calculate cursor with last post's trendingScore for proper pagination
      let nextCursor: string | undefined;
      if (postsToReturn.length > 0) {
        const lastPost = postsToReturn[postsToReturn.length - 1];
        const lastPostScore = typeof lastPost.trendingScore === 'number' && !isNaN(lastPost.trendingScore) 
          ? lastPost.trendingScore 
          : 0;
        
        // Encode as compound cursor (trendingScore + _id) for trending feeds
        const cursorData = {
          _id: lastPost._id.toString(),
          minScore: lastPostScore
        };
        nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
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
      console.error('Error fetching explore feed:', error);
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
      console.error('Error fetching media feed:', error);
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

      // Check profile privacy settings
      const userSettings = await UserSettings.findOne({ oxyUserId: userId }).lean();
      const profileVisibility = userSettings?.privacy?.profileVisibility || 'public';
      const isOwnProfile = currentUserId === userId;
      
      // If profile is private or followers_only, check access
      if (!isOwnProfile && (profileVisibility === 'private' || profileVisibility === 'followers_only')) {
        if (!currentUserId) {
          // Not authenticated - return empty feed
          return res.json({ items: [], hasMore: false, nextCursor: undefined, totalCount: 0 });
        }
        
        // Check if current user is following the profile owner
        try {
          const followingRes = await oxyClient.getUserFollowing(currentUserId);
          const followingList = Array.isArray((followingRes as any)?.following)
            ? (followingRes as any).following
            : (Array.isArray(followingRes) ? followingRes : []);
          const followingIds = followingList.map((u: any) => 
            typeof u === 'string' ? u : (u?.id || u?._id || u?.userId || u?.user?.id || u?.profile?.id || u?.targetId)
          ).filter(Boolean);
          
          const isFollowing = followingIds.includes(userId);
          
          if (!isFollowing) {
            // Not following - return empty feed
            return res.json({ items: [], hasMore: false, nextCursor: undefined, totalCount: 0 });
          }
        } catch (error) {
          console.error('Error checking follow status:', error);
          // On error, deny access for privacy
          return res.json({ items: [], hasMore: false, nextCursor: undefined, totalCount: 0 });
        }
      }

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
        }).lean();

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
      console.error('Error fetching user profile feed:', error);
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
                const authorFollowing = await oxyClient.getUserFollowing(parentAuthorId);
                canReply = authorFollowing?.following?.some((f: any) => {
                  const followingId = f.id || f._id || f;
                  return followingId === currentUserId || String(followingId) === String(currentUserId);
                }) || false;
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
            console.error('Error checking reply permissions:', error);
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
      console.error('Error creating reply:', error);
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
        console.warn('Failed to record interaction for preferences:', error);
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
      console.error('Error creating repost:', error);
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

      console.log(`[Like] Like request received: userId=${currentUserId}, postId=${postId}`);

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
        console.log(`[Like] Post ${postId} already liked by user ${currentUserId}`);
        // Still record the interaction even if already liked (user expressed interest)
        try {
          await userPreferenceService.recordInteraction(currentUserId, postId, 'like');
          console.log(`[Like] Recorded interaction for already-liked post`);
        } catch (error) {
          console.warn(`[Like] Failed to record interaction for already-liked post:`, error);
        }
        return res.json({ 
          success: true, 
          liked: true,
          likesCount: existingPost.stats.likesCount,
          message: 'Already liked'
        });
      }

      console.log(`[Like] User ${currentUserId} liking post ${postId} (not already liked)`);

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
      console.log(`[Like] Recording interaction for user ${currentUserId}, post ${postId}`);
      try {
        await userPreferenceService.recordInteraction(currentUserId, postId, 'like');
        console.log(`[Like] Successfully recorded interaction`);
        // Invalidate cached feed for this user
        await feedCacheService.invalidateUserCache(currentUserId);
      } catch (error) {
        console.error(`[Like] Failed to record interaction for preferences:`, error);
        console.error(`[Like] Error stack:`, error instanceof Error ? error.stack : 'No stack trace');
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
      console.error('Error liking post:', error);
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
        console.warn('Failed to invalidate cache:', error);
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
      console.error('Error unliking post:', error);
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

      console.log('🔄 Unrepost request:', { postId, currentUserId });

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
      console.error('Error unreposting:', error);
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

      console.log(`[Save] Save request received: userId=${currentUserId}, postId=${postId}`);

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
        console.log(`[Save] Post ${postId} already saved by user ${currentUserId}`);
        // Still record the interaction even if already saved (user expressed interest)
        try {
          await userPreferenceService.recordInteraction(currentUserId, postId, 'save');
          console.log(`[Save] Recorded interaction for already-saved post`);
        } catch (error) {
          console.warn(`[Save] Failed to record interaction for already-saved post:`, error);
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
      console.log(`[Save] Recording interaction for user ${currentUserId}, post ${postId}`);
      try {
        await userPreferenceService.recordInteraction(currentUserId, postId, 'save');
        console.log(`[Save] Successfully recorded interaction`);
        // Invalidate cached feed for this user
        await feedCacheService.invalidateUserCache(currentUserId);
      } catch (error) {
        console.error(`[Save] Failed to record interaction for preferences:`, error);
        console.error(`[Save] Error stack:`, error instanceof Error ? error.stack : 'No stack trace');
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
      console.error('Error saving post:', error);
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

      console.log('🗑️ Unsave endpoint called:', { postId, currentUserId, user: req.user });

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
      console.error('Error unsaving post:', error);
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
      console.error('Error fetching feed item:', error);
      res.status(500).json({ error: 'Failed to fetch feed item' });
    }
  }
}

export const feedController = new FeedController();
export default feedController;
