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

interface AuthRequest extends Request {
  user?: {
    id: string;
    [key: string]: any;
  };
}

class FeedController {
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

          // Get all posts with their metadata to check for interactions
          const postsWithMetadata = await Post.find({
            _id: { $in: postIds }
          }).select('_id metadata.likedBy metadata.savedBy');

          const postsMissingLikeMetadata: string[] = [];
          // Check likes and saves by examining the metadata arrays
          postsWithMetadata.forEach(post => {
            const postId = post._id.toString();
            const metadata = post.metadata || {};
            const likedBy = metadata.likedBy || [];
            const savedBy = metadata.savedBy || [];

            // Check likes with multiple formats for robust comparison
            const userLiked = likedBy.includes(currentUserId) || 
                            likedBy.includes(currentUserId?.toString()) ||
                            likedBy.some(id => id?.toString() === currentUserId?.toString());
            
            if (userLiked) {
              userInteractions.set(postId, {
                ...userInteractions.get(postId),
                isLiked: true
              });
            } else if (currentUserId) {
              postsMissingLikeMetadata.push(postId);
            }

            // Check saves with multiple formats for robust comparison  
            const userSaved = savedBy.includes(currentUserId) ||
                            savedBy.includes(currentUserId?.toString()) ||
                            savedBy.some(id => id?.toString() === currentUserId?.toString());

            if (userSaved) {
              userInteractions.set(postId, {
                ...userInteractions.get(postId),
                isSaved: true
              });
            }
          });

          if (postsMissingLikeMetadata.length) {
            try {
              const legacyLikes = await Like.find({
                userId: currentUserId,
                postId: { $in: postsMissingLikeMetadata }
              }).select('postId').lean();

              if (legacyLikes.length) {
                const likedIds = legacyLikes
                  .map((like: any) => like.postId?.toString?.())
                  .filter(Boolean);

                likedIds.forEach((likedId) => {
                  userInteractions.set(likedId, {
                    ...userInteractions.get(likedId),
                    isLiked: true
                  });
                });

                // Backfill metadata.likedBy so future requests do not rely on Like collection
                const objectIds = likedIds
                  .map((id) => {
                    try {
                      return new mongoose.Types.ObjectId(id);
                    } catch {
                      return null;
                    }
                  })
                  .filter(Boolean) as mongoose.Types.ObjectId[];

                if (objectIds.length) {
                  await Post.updateMany(
                    { _id: { $in: objectIds } },
                    { $addToSet: { 'metadata.likedBy': currentUserId } }
                  );
                }
              }
            } catch (fallbackError) {
              console.warn('Failed fallback like lookup for metadata sync:', fallbackError);
            }
          }

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
          // Shallow metadata for flags; compute liked/saved for current user if arrays present
          metadata: (() => {
            const md = obj.metadata || {};
            const likedBy: any[] = md.likedBy || [];
            const savedBy: any[] = md.savedBy || [];
            const liked = currentUserId ? (likedBy.includes(currentUserId) || likedBy.some((x: any) => x?.toString?.() === String(currentUserId))) : false;
            const saved = currentUserId ? (savedBy.includes(currentUserId) || savedBy.some((x: any) => x?.toString?.() === String(currentUserId))) : false;
            return { ...md, isLiked: liked, isSaved: saved };
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
        const isLiked = interactions.isLiked || false;
        const isReposted = interactions.isReposted || false;
        const isSaved = interactions.isSaved || false;
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
          stats: stats, // Use the processed stats object
          metadata: {
            ...postObj.metadata,
            isLiked,
            isReposted,
            isSaved,
          },
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
              console.warn('Failed to expand feed.sourceListIds:', e?.message || e);
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
        console.warn('Optional customFeedId expansion failed:', e?.message || e);
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
        console.warn('Optional listIds expansion failed:', e?.message || e);
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
      const nextCursor = hasMore ? posts[limit - 1]._id.toString() : undefined;

      if (type === 'saved') {
        console.log(`[Saved Feed] Returning ${postsToReturn.length} posts, hasMore: ${hasMore}`);
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

      // Emit real-time update to connected clients
      if (postsToReturn.length > 0) {
        io.emit('feed:updated', {
          type,
          posts: transformedPosts,
          timestamp: new Date().toISOString()
        });
      }

      const response: FeedResponse = {
        items: transformedPosts, // Return posts directly in new schema format
        hasMore,
        nextCursor,
        totalCount: transformedPosts.length
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

        const response: FeedResponse = {
          items: transformedPosts,
          hasMore,
          nextCursor,
          totalCount: transformedPosts.length
        };

        return res.json(response);
      }

      // Following for personalization (authenticated users only)
      let followingIds: string[] = [];
      try {
        if (currentUserId) {
          const followingRes = await oxyClient.getUserFollowing(currentUserId);
          const followingUsers = (followingRes as any)?.following || [];
          followingIds = followingUsers.map((u: any) => u.id).filter(Boolean);
        }
      } catch (e) {
        console.error('ForYou: getUserFollowing failed; continuing without follow boost', e);
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

      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const posts = await Post.aggregate([
        { $match: match },
        // CRITICAL: Group by _id to ensure no duplicates from aggregation
        // This is a defensive measure to prevent any potential duplicate documents
        {
          $group: {
            _id: '$_id',
            doc: { $first: '$$ROOT' }
          }
        },
        {
          $replaceRoot: { newRoot: '$doc' }
        },
        {
          $addFields: {
            engagementScore: {
              $add: [
                { $ifNull: ['$stats.likesCount', 0] },
                { $multiply: [{ $ifNull: ['$stats.repostsCount', 0] }, 2] },
                { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, 1.5] }
              ]
            },
            followBoost: { $cond: [{ $in: ['$oxyUserId', followingIds] }, 1.5, 1] },
            interactionBoost: {
              $cond: [
                { $or: [
                  { $in: [currentUserId || '', '$metadata.likedBy'] },
                  { $in: [currentUserId || '', '$metadata.savedBy'] }
                ]}, 1.2, 1]
            },
            recencyBoost: {
              $cond: [
                { $gte: ['$createdAt', threeDaysAgo] }, 1.3,
                { $cond: [ { $gte: ['$createdAt', sevenDaysAgo] }, 1.15, 1 ] }
              ]
            }
          }
        },
        {
          $addFields: {
            finalScore: {
              $multiply: ['$engagementScore', '$followBoost', '$interactionBoost', '$recencyBoost']
            }
          }
        },
        // Apply compound filtering to prevent duplicates when paginating
        // CRITICAL: We must filter by BOTH finalScore and _id together to prevent duplicates
        // For engagement-sorted feeds, we exclude posts that appeared on page 1:
        //   - Posts with finalScore > lastPostScore (definitely appeared on page 1)
        //   - Posts with finalScore = lastPostScore AND _id >= cursorId (appeared on page 1)
        // We include only posts that haven't been shown:
        //   - Posts with finalScore < lastPostScore (always include, no _id check needed), OR
        //   - Posts with finalScore = lastPostScore AND _id < cursorId (include if lower _id)
        // This ensures no posts appear on multiple pages
        ...(minFinalScore !== undefined && cursorId ? [{
          $match: {
            $or: [
              { finalScore: { $lt: minFinalScore } },
              {
                $and: [
                  { finalScore: minFinalScore },
                  { _id: { $lt: new mongoose.Types.ObjectId(cursorId) } }
                ]
              }
            ]
          }
        }] : []),
        { $sort: { finalScore: -1, _id: -1 } },
        { $limit: Number(limit) + 1 }
      ]);

      const hasMore = posts.length > Number(limit);
      const postsToReturn = hasMore ? posts.slice(0, Number(limit)) : posts;
      
      // Calculate cursor with last post's finalScore for proper pagination
      // This ensures we exclude higher-scoring posts on subsequent pages
      // We use the LAST post's score (not minimum) to ensure correct pagination
      let nextCursor: string | undefined;
      if (postsToReturn.length > 0) {
        const lastPost = postsToReturn[postsToReturn.length - 1];
        const lastPostScore = typeof lastPost.finalScore === 'number' && !isNaN(lastPost.finalScore) 
          ? lastPost.finalScore 
          : 0;
        
        // Encode as compound cursor (lastPostScore + _id) for engagement-based feeds
        // This allows us to properly paginate engagement-sorted feeds
        // The cursor represents: "show me posts with score < lastPostScore OR (score = lastPostScore AND _id < lastPost._id)"
        const cursorData = {
          _id: lastPost._id.toString(),
          minScore: lastPostScore
        };
        nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
        
        // Log cursor for debugging
        console.log('📌 Generated nextCursor:', {
          lastPostId: lastPost._id.toString(),
          lastPostScore,
          nextCursor: nextCursor.substring(0, 30) + '...',
          returnedCount: postsToReturn.length
        });
      }

      // CRITICAL: Multi-stage deduplication to ensure no duplicates
      // Stage 1: Deduplicate raw posts by _id (MongoDB ObjectId) before transformation
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

      // Stage 2: Transform deduplicated posts
      const transformedPosts = await this.transformPostsWithProfiles(deduplicatedRawPosts, currentUserId);

      // Stage 3: Deduplicate transformed posts by id (defensive check)
      const transformedIdsSeen = new Map<string, any>();
      const deduplicatedPosts = transformedPosts.filter(post => {
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

      const response: FeedResponse = {
        items: finalDeduplicated, // Return fully deduplicated posts
        hasMore: hasMore && finalDeduplicated.length === deduplicatedRawPosts.length, // Adjust hasMore if deduplication removed items
        nextCursor,
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
      const followingIds = [
        ...new Set([
          ...extracted.filter(Boolean),
          currentUserId // include user's own posts
        ])
      ];

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

      const response: FeedResponse = {
        items: transformedPosts, // Return posts directly in new schema format
        hasMore,
        nextCursor,
        totalCount: transformedPosts.length
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

      // Calculate engagement score including all engagement metrics
      // Include likes, reposts, replies (comments), and bookmarks (saves) in the score
      const posts = await Post.aggregate([
        { $match: match },
        {
          $addFields: {
            // Get bookmark/save count from metadata.savedBy array length
            bookmarksCount: { $size: { $ifNull: ['$metadata.savedBy', []] } },
            engagementScore: {
              $add: [
                { $ifNull: ['$stats.likesCount', 0] },
                { $multiply: [{ $ifNull: ['$stats.repostsCount', 0] }, 2] }, // Reposts weighted 2x
                { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, 1.5] }, // Comments weighted 1.5x
                { $multiply: [{ $size: { $ifNull: ['$metadata.savedBy', []] } }, 1.2] } // Bookmarks weighted 1.2x
              ]
            },
          }
        },
        // NO engagement threshold filter - show ALL posts sorted by engagement
        // Posts with 0 engagement will naturally be at the bottom
        // Apply compound filtering to prevent duplicates when paginating
        ...(minFinalScore !== undefined && cursorId ? [{
          $match: {
            $or: [
              { engagementScore: { $lt: minFinalScore } },
              {
                $and: [
                  { engagementScore: minFinalScore },
                  // Validate ObjectId to prevent injection
                  { _id: mongoose.Types.ObjectId.isValid(cursorId) ? { $lt: new mongoose.Types.ObjectId(cursorId) } : { $exists: false } }
                ]
              }
            ]
          }
        }] : []),
        { $sort: { engagementScore: -1, _id: -1 } },
        { $limit: limit + 1 }
      ]);

      const hasMore = posts.length > limit;
      const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
      
      // Calculate cursor with last post's engagementScore for proper pagination
      let nextCursor: string | undefined;
      if (postsToReturn.length > 0) {
        const lastPost = postsToReturn[postsToReturn.length - 1];
        const lastPostScore = typeof lastPost.engagementScore === 'number' && !isNaN(lastPost.engagementScore) 
          ? lastPost.engagementScore 
          : 0;
        
        // Encode as compound cursor (engagementScore + _id) for engagement-based feeds
        const cursorData = {
          _id: lastPost._id.toString(),
          minScore: lastPostScore
        };
        nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
      }

      const transformedPosts = await this.transformPostsWithProfiles(postsToReturn, currentUserId);

      const response: FeedResponse = {
        items: transformedPosts,
        hasMore,
        nextCursor,
        totalCount: transformedPosts.length
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

  // Create reply post
  // Extract hashtags from content
  const extractedTags = Array.from((replyContent?.text || '').matchAll(/#([A-Za-z0-9_]+)/g)).map(m => m[1].toLowerCase());
      const mergedTags = Array.from(new Set([...(hashtags || []), ...extractedTags]));

      const reply = new Post({
        oxyUserId: currentUserId,
        type: PostType.TEXT,
        content: replyContent,
        visibility: PostVisibility.PUBLIC,
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

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Check if user already liked this post
      const existingPost = await Post.findById(postId);
      if (!existingPost) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const alreadyLiked = existingPost.metadata?.likedBy?.includes(currentUserId);
      
      if (alreadyLiked) {
        return res.json({ 
          success: true, 
          liked: true,
          likesCount: existingPost.stats.likesCount,
          message: 'Already liked'
        });
      }

      // Update post like count and add user to likedBy array
      const updateResult = await Post.findByIdAndUpdate(
        postId,
        {
          $inc: { 'stats.likesCount': 1 },
          $addToSet: { 'metadata.likedBy': currentUserId }
        },
        { new: true }
      );

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

      // Check if user has liked this post
      const existingPost = await Post.findById(postId);
      if (!existingPost) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const hasLiked = existingPost.metadata?.likedBy?.includes(currentUserId);
      
      if (!hasLiked) {
        return res.json({ 
          success: true, 
          liked: false,
          likesCount: existingPost.stats.likesCount,
          message: 'Not liked'
        });
      }

      // Update post like count and remove user from likedBy array
      const updateResult = await Post.findByIdAndUpdate(
        postId,
        {
          $inc: { 'stats.likesCount': -1 },
          $pull: { 'metadata.likedBy': currentUserId }
        },
        { new: true }
      );

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

      console.log('💾 Save endpoint called:', { postId, currentUserId, user: req.user });

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
