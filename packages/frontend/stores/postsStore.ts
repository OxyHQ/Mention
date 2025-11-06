import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { 
  FeedRequest, 
  CreateReplyRequest, 
  CreateRepostRequest, 
  CreatePostRequest,
  CreateThreadRequest,
  LikeRequest, 
  UnlikeRequest,
  FeedType,
  PostContent
} from '@mention/shared-types';
import { feedService } from '../services/feedService';
import { useUsersStore } from './usersStore';
import { markLocalAction } from '../services/echoGuard';

interface FeedItem {
  id: string;
  user: {
    id: string;
    name: string;
    handle: string;
    avatar: string;
    verified: boolean;
  };
  content: PostContent;
  date: string;
  engagement: {
    replies: number;
    reposts: number;
    likes: number;
  };
  media?: string[];
  mediaIds?: string[];
  originalMediaIds?: string[];
  allMediaIds?: string[];
  isLiked?: boolean;
  isReposted?: boolean;
  isSaved?: boolean;
  type?: string;
  visibility?: string;
  hashtags?: string[];
  mentions?: string[];
  parentPostId?: string;
  threadId?: string;
  repostOf?: string;
  quoteOf?: string;
  isEdited?: boolean;
  language?: string;
  stats?: any;
  metadata?: any;
  isLocalNew?: boolean;
}

interface FeedState {
  feeds: Record<FeedType, {
    items: FeedItem[];
    hasMore: boolean;
    nextCursor?: string;
    totalCount: number;
    isLoading: boolean;
    error: string | null;
    lastUpdated: number;
    filters?: Record<string, any>;
  }>;
  
  userFeeds: Record<string, Record<FeedType, {
    items: FeedItem[];
    hasMore: boolean;
    nextCursor?: string;
    totalCount: number;
    isLoading: boolean;
    error: string | null;
    lastUpdated: number;
  }>>;

  postsById: Record<string, FeedItem>;
  isLoading: boolean;
  error: string | null;
  lastRefresh: number;
  
  fetchFeed: (request: FeedRequest) => Promise<void>;
  fetchUserFeed: (userId: string, request: FeedRequest) => Promise<void>;
  fetchSavedPosts: (request: { page?: number; limit?: number }) => Promise<void>;
  refreshFeed: (type: FeedType, filters?: Record<string, any>) => Promise<void>;
  loadMoreFeed: (type: FeedType, filters?: Record<string, any>) => Promise<void>;
  
  createPost: (request: CreatePostRequest) => Promise<FeedItem | null>;
  createThread: (request: CreateThreadRequest) => Promise<FeedItem[]>;
  createReply: (request: CreateReplyRequest) => Promise<void>;
  createRepost: (request: CreateRepostRequest) => Promise<void>;
  repostPost: (request: { postId: string }) => Promise<void>;
  unrepostPost: (request: { postId: string }) => Promise<void>;
  likePost: (request: LikeRequest) => Promise<void>;
  unlikePost: (request: UnlikeRequest) => Promise<void>;
  savePost: (request: { postId: string }) => Promise<void>;
  unsavePost: (request: { postId: string }) => Promise<void>;
  getPostById: (postId: string) => Promise<any>;
  
  // Local state updates
  updatePostLocally: (postId: string, updates: Partial<FeedItem>) => void;
  updatePostEverywhere: (
    postId: string,
    updater: (prev: FeedItem) => FeedItem | null | undefined
  ) => void;
  removePostEverywhere: (postId: string) => void;
  removePostLocally: (postId: string, feedType: FeedType) => void;
  addPostToFeed: (post: FeedItem, feedType: FeedType) => void;
  addPostsToFeed: (posts: FeedItem[], feedType: FeedType) => void;
  
  // Utility actions
  clearError: () => void;
  clearFeed: (type: FeedType) => void;
  clearUserFeed: (userId: string, type: FeedType) => void;
}

// Default feed state
const createDefaultFeedState = () => ({
  items: [],
  hasMore: true,
  nextCursor: undefined,
  totalCount: 0,
  isLoading: false,
  error: null,
  lastUpdated: 0
});

// Default feeds state
const createDefaultFeedsState = () => ({
  posts: createDefaultFeedState(),
  replies: createDefaultFeedState(),
  reposts: createDefaultFeedState(),
  media: createDefaultFeedState(),
  likes: createDefaultFeedState(),
  saved: createDefaultFeedState(),
  mixed: createDefaultFeedState(),
  for_you: createDefaultFeedState(),
  following: createDefaultFeedState(),
  explore: createDefaultFeedState(), // Trending feed
  custom: createDefaultFeedState(), // Custom feeds
});

type TransformOptions = {
  skipRelated?: boolean;
};

const primeRelatedPosts = (cache: Record<string, FeedItem>, post: any) => {
  if (!post) return;
  const original = (post as any)?.original;
  if (original?.id) {
    cache[original.id] = original as FeedItem;
  }
  const quoted = (post as any)?.quoted;
  if (quoted?.id) {
    cache[quoted.id] = quoted as FeedItem;
  }
};

/**
 * Normalize item ID to a consistent string format
 * Handles various ID formats: id, _id, _id_str, postId, post.id, post._id
 */
const normalizeId = (item: any): string => {
  if (!item) return '';
  
  // Direct ID fields (most common)
  if (item.id != null) return String(item.id);
  if (item._id != null) {
    const _id = item._id;
    return typeof _id === 'object' && typeof _id.toString === 'function'
      ? _id.toString()
      : String(_id);
  }
  
  // Alternative ID fields
  if (item._id_str != null) return String(item._id_str);
  if (item.postId != null) return String(item.postId);
  
  // Nested post ID fields
  if (item.post?.id != null) return String(item.post.id);
  if (item.post?._id != null) {
    const _id = item.post._id;
    return typeof _id === 'object' && typeof _id.toString === 'function'
      ? _id.toString()
      : String(_id);
  }
  
  return '';
};

/**
 * Check if an ID is valid (not empty or placeholder values)
 */
const isValidId = (id: string): boolean => {
  return id !== '' && id !== 'undefined' && id !== 'null';
};

/**
 * Deduplicate items by normalized ID
 * 
 * - Keeps first occurrence of each unique ID (preserves order)
 * - Filters out items without valid IDs
 * - Uses Map for O(1) lookup performance
 * 
 * @param items Array of items to deduplicate
 * @param source Optional source identifier for logging
 * @returns Array of unique items in original order
 */
const deduplicateItems = <T = any>(items: T[], source?: string): T[] => {
  if (!items || items.length === 0) return [];
  
  const seen = new Map<string, T>();
  const invalidItems: T[] = [];
  const duplicateIds: string[] = [];
  
  for (const item of items) {
    const id = normalizeId(item);
    
    if (!isValidId(id)) {
      invalidItems.push(item);
      continue;
    }
    
    // Only add if we haven't seen this ID before
    if (!seen.has(id)) {
      seen.set(id, item);
    } else {
      duplicateIds.push(id);
    }
  }
  
  const duplicatesRemoved = duplicateIds.length;
  const invalidRemoved = invalidItems.length;
  
  // Log duplicates and invalid items in development
  if (process.env.NODE_ENV === 'development') {
    if (duplicatesRemoved > 0) {
      console.warn(`[deduplicateItems${source ? `:${source}` : ''}] Removed ${duplicatesRemoved} duplicate(s):`, duplicateIds.slice(0, 5));
    }
    if (invalidRemoved > 0) {
      console.warn(`[deduplicateItems${source ? `:${source}` : ''}] Filtered ${invalidRemoved} items without valid IDs`);
    }
  }
  
  return Array.from(seen.values());
};

const transformToUIItem = (raw: any, options: TransformOptions = {}) => {
  const engagement = raw?.engagement || {
    replies: raw?.stats?.commentsCount || 0,
    reposts: raw?.stats?.repostsCount || 0,
    likes: raw?.stats?.likesCount || 0,
  };

  // Extract isLiked with proper fallback - check multiple sources
  const extractIsLiked = (): boolean => {
    // 1. Check top-level isLiked (preferred - backend now sets this)
    if (raw?.isLiked !== undefined && raw?.isLiked !== null) {
      return Boolean(raw.isLiked);
    }
    // 2. Check metadata.isLiked (fallback)
    if (raw?.metadata?.isLiked !== undefined && raw?.metadata?.isLiked !== null) {
      return Boolean(raw.metadata.isLiked);
    }
    // 3. Check likedBy array as last resort (for edge cases where backend didn't set flags)
    if (raw?.metadata?.likedBy && Array.isArray(raw.metadata.likedBy) && raw.metadata.likedBy.length > 0) {
      // This is a fallback - ideally backend should always set isLiked
      // We can't check currentUserId here, so we'll default to false
      // Backend should handle this properly
    }
    return false;
  };

  const extractIsSaved = (): boolean => {
    if (raw?.isSaved !== undefined) return Boolean(raw.isSaved);
    if (raw?.metadata?.isSaved !== undefined) return Boolean(raw.metadata.isSaved);
    return false;
  };

  const extractIsReposted = (): boolean => {
    if (raw?.isReposted !== undefined) return Boolean(raw.isReposted);
    if (raw?.metadata?.isReposted !== undefined) return Boolean(raw.metadata.isReposted);
    return false;
  };

  const base = {
    ...raw,
    id: String(raw?.id || raw?._id),
    content: raw?.content || { text: '' },
    mediaIds: raw?.mediaIds,
    originalMediaIds: raw?.originalMediaIds,
    allMediaIds: raw?.allMediaIds,
    isSaved: extractIsSaved(),
    isLiked: extractIsLiked(),
    isReposted: extractIsReposted(),
    postId: raw?.postId || raw?.parentPostId,
    originalPostId: raw?.originalPostId || raw?.repostOf,
    engagement,
  };

  if (!options.skipRelated) {
    if (raw?.original) {
      const original = transformToUIItem(raw.original, { skipRelated: true });
      if (original?.id) {
        (base as any).original = original;
      }
    }
    if (raw?.quoted) {
      const quoted = transformToUIItem(raw.quoted, { skipRelated: true });
      if (quoted?.id) {
        (base as any).quoted = quoted;
      }
    }
  }

  return base;
};

export const usePostsStore = create<FeedState>()(
  subscribeWithSelector((set, get) => ({
    feeds: createDefaultFeedsState(),
    userFeeds: {},
    postsById: {},
    isLoading: false,
    error: null,
    lastRefresh: Date.now(),

    fetchFeed: async (request: FeedRequest) => {
      const { type = 'mixed' } = request;
      const state = get();
      const currentFeed = state.feeds[type];
      
      // Prevent concurrent requests
      if (currentFeed?.isLoading) {
        return;
      }
      
      // Check if filters changed - if so, clear old items before fetching
      const filtersChanged = !request.cursor && currentFeed?.items && currentFeed.items.length > 0 &&
        JSON.stringify(request.filters || {}) !== JSON.stringify(currentFeed.filters || {});
      
      // Skip if we have items AND no cursor AND no filters change
      if (!request.cursor && currentFeed?.items && currentFeed.items.length > 0 && !filtersChanged) {
        return;
      }
      
      // If filters changed, clear old items to show new filtered results
      // Clear items immediately so UI doesn't show stale data
      set(state => ({
        feeds: {
          ...state.feeds,
          [type]: {
            ...state.feeds[type],
            items: filtersChanged ? [] : state.feeds[type]?.items || [], // Clear items when filters change
            isLoading: true,
            error: null
          }
        }
      }));

      try {
        const response = await feedService.getFeed(request);
        
        set(state => {
          // Re-check loading state - another request might have completed
          const currentFeedState = state.feeds[type];
          if (!currentFeedState?.isLoading && request.cursor) {
            // Another request completed, discard this response to prevent race conditions
            return state;
          }
          
          // Transform and deduplicate items
          const items = response.items?.map(item => transformToUIItem(item)) || [];
          const uniqueItems = deduplicateItems(items, `fetchFeed:${type}`);
          
          // DEBUG: Log response details
          if (process.env.NODE_ENV === 'development') {
            const responseIds = items.map(item => normalizeId(item));
            const uniqueResponseIds = new Set(responseIds);
            if (responseIds.length !== uniqueResponseIds.size) {
              const duplicates = responseIds.filter((id, idx) => responseIds.indexOf(id) !== idx);
              console.error(`[fetchFeed:${type}] Backend returned ${duplicates.length} duplicate IDs:`, [...new Set(duplicates)].slice(0, 10));
            }
            console.log(`[fetchFeed:${type}] Response: ${items.length} items → ${uniqueItems.length} unique`, {
              backendSent: items.length,
              afterDedup: uniqueItems.length,
              removed: items.length - uniqueItems.length,
              hasMore: response.hasMore,
              cursor: response.nextCursor ? 'present' : 'none'
            });
          }
          
          // Update cache
          try { useUsersStore.getState().primeFromPosts(uniqueItems as any); } catch {}
          const newCache = { ...state.postsById };
          uniqueItems.forEach((p: FeedItem) => {
            const id = normalizeId(p);
            if (id) {
              newCache[id] = p;
              primeRelatedPosts(newCache, p);
            }
          });
          
          // fetchFeed ALWAYS replaces items completely (never merges)
          // Merging is handled by loadMoreFeed for pagination
          const updatedFeed = {
            items: uniqueItems,
            hasMore: response.hasMore || false,
            nextCursor: response.nextCursor,
            totalCount: uniqueItems.length,
            isLoading: false,
            error: null,
            lastUpdated: Date.now(),
            filters: request.filters
          };
          
          return ({
            feeds: {
              ...state.feeds,
              [type]: updatedFeed
            },
            postsById: newCache,
            lastRefresh: Date.now()
          });
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch feed';
        
        set(state => ({
          feeds: {
            ...state.feeds,
            [type]: {
              ...state.feeds[type],
              isLoading: false,
              error: errorMessage
            }
          },
          error: errorMessage
        }));
      }
    },

    fetchUserFeed: async (userId: string, request: FeedRequest) => {
      const { type = 'posts' } = request;
      
      set(state => ({
        userFeeds: {
          ...state.userFeeds,
          [userId]: {
            ...state.userFeeds[userId],
            [type]: {
              ...(state.userFeeds[userId]?.[type] || createDefaultFeedState()),
              isLoading: true,
              error: null
            }
          }
        }
      }));

      try {
        const response = await feedService.getUserFeed(userId, request);

        set(state => {
          const prev = state.userFeeds[userId]?.[type] || createDefaultFeedState();
          const mapped = response.items?.map(item => transformToUIItem(item)) || [];
          
          // Helper function to normalize ID consistently
          const normalizeId = (p: any): string => {
            if (p?.id) return String(p.id);
            if ((p as any)?._id) {
              const _id = (p as any)._id;
              return typeof _id === 'object' && _id.toString 
                ? _id.toString() 
                : String(_id);
            }
            return '';
          };
          
          // Deduplicate new batch first
          const uniqueMapped = deduplicateItems(mapped);
          
          // Prime users cache from items
          try { useUsersStore.getState().primeFromPosts(uniqueMapped as any); } catch {}

          let mergedItems: FeedItem[] = uniqueMapped;
          let addedCount = uniqueMapped.length;
          if (request.cursor) {
            const existingIds = new Map<string, boolean>();
            (prev.items || []).forEach((p: FeedItem) => {
              const id = normalizeId(p);
              if (id && id !== 'undefined' && id !== 'null') {
                existingIds.set(id, true);
              }
            });
            
            const uniqueNew = uniqueMapped.filter(p => {
              const id = normalizeId(p);
              return id && !existingIds.has(id);
            });
            mergedItems = (prev.items || []).concat(uniqueNew);
            addedCount = uniqueNew.length;
          }

          const finalUniqueItems = deduplicateItems(mergedItems);
          const newCache = { ...state.postsById };
          finalUniqueItems.forEach((p: FeedItem) => {
            const id = normalizeId(p);
            if (id) {
              newCache[id] = p;
              primeRelatedPosts(newCache, p);
            }
          });

          const prevCursor = prev.nextCursor;
          const nextCursor = response.nextCursor;
          const cursorAdvanced = !!nextCursor && nextCursor !== prevCursor;
          const hasMore = Boolean(response.hasMore) || (cursorAdvanced && addedCount >= 0);
          const safeHasMore = (addedCount > 0 || cursorAdvanced) ? hasMore : false;

          return ({
            userFeeds: {
              ...state.userFeeds,
              [userId]: {
                ...state.userFeeds[userId],
                [type]: {
                  items: finalUniqueItems,
                  hasMore: safeHasMore,
                  nextCursor,
                  totalCount: finalUniqueItems.length,
                  isLoading: false,
                  error: null,
                  lastUpdated: Date.now()
                }
              }
            },
            postsById: newCache
          });
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch user feed';
        
        set(state => ({
          userFeeds: {
            ...state.userFeeds,
            [userId]: {
              ...state.userFeeds[userId],
              [type]: {
                ...(state.userFeeds[userId]?.[type] || createDefaultFeedState()),
                isLoading: false,
                error: errorMessage
              }
            }
          }
        }));
      }
    },

    fetchSavedPosts: async (request: { page?: number; limit?: number } = {}) => {
      set(state => ({
        feeds: {
          ...state.feeds,
          ['saved']: {
            ...(state.feeds as any)['saved'],
            isLoading: true,
            error: null
          }
        }
      }));

      try {
        const response = await feedService.getSavedPosts(request);

        let processedPosts = response.data.posts?.map((post: any) => transformToUIItem({ ...post, isSaved: true })) || [];

        // Fallback: if API returns empty, derive from currently loaded feeds
        if (!processedPosts.length) {
          const state = get();
          const types = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes', 'saved'] as const;
          const seen = new Set<string>();
          const localSaved: FeedItem[] = [];
          types.forEach((t) => {
            (state.feeds as any)[t]?.items?.forEach((p: any) => {
              if (p?.isSaved && !seen.has(p.id)) {
                seen.add(p.id);
                localSaved.push(p);
              }
            });
          });
          if (localSaved.length) {
            processedPosts = localSaved;
          }
        }

        set(state => {
          const newCache = { ...state.postsById };
          processedPosts.forEach((p: FeedItem) => {
            newCache[p.id] = p;
            primeRelatedPosts(newCache, p);
          });

          return ({
            feeds: {
              ...state.feeds,
              ['saved']: {
                items: processedPosts,
                hasMore: response.data.hasMore || false,
                nextCursor: undefined,
                totalCount: processedPosts.length,
                isLoading: false,
                error: null,
                lastUpdated: Date.now()
              }
            },
            postsById: newCache,
            lastRefresh: Date.now()
          });
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch saved posts';
        
        set(state => ({
          feeds: {
            ...state.feeds,
            ['saved']: {
              ...(state.feeds as any)['saved'],
              isLoading: false,
              error: errorMessage
            }
          },
          error: errorMessage
        }));
      }
    },

    refreshFeed: async (type: FeedType, filters?: Record<string, any>) => {
      const state = get();
      const currentFeed = state.feeds[type];
      
      if (!currentFeed) return;

      if (currentFeed.isLoading) {
        return;
      }

      set(state => ({
        feeds: {
          ...state.feeds,
          [type]: {
            ...state.feeds[type],
            isLoading: true,
            error: null,
            items: []
          }
        }
      }));

      try {
        const response = await feedService.getFeed({
          type,
          limit: 20,
          filters
        } as any);

        set(state => {
          // Transform and deduplicate items
          const items = response.items?.map(item => transformToUIItem(item)) || [];
          const uniqueItems = deduplicateItems(items, `refreshFeed:${type}`);
          
          // Update cache
          try { useUsersStore.getState().primeFromPosts(uniqueItems as any); } catch {}
          const newCache = { ...state.postsById };
          uniqueItems.forEach((p: FeedItem) => {
            const id = normalizeId(p);
            if (id) {
              newCache[id] = p;
              primeRelatedPosts(newCache, p);
            }
          });

          return ({
            feeds: {
              ...state.feeds,
              [type]: {
                items: uniqueItems,
                hasMore: response.hasMore || false,
                nextCursor: response.nextCursor,
                totalCount: uniqueItems.length,
                isLoading: false,
                error: null,
                lastUpdated: Date.now()
              }
            },
            postsById: newCache,
            lastRefresh: Date.now()
          });
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to refresh feed';
        
        set(state => ({
          feeds: {
            ...state.feeds,
            [type]: {
              ...state.feeds[type],
              isLoading: false,
              error: errorMessage
            }
          }
        }));
      }
    },

    // Load more feed (infinite scroll)
    loadMoreFeed: async (type: FeedType, filters?: Record<string, any>) => {
      const state = get();
      const currentFeed = state.feeds[type];
      
      // Enhanced guard: prevent concurrent loads and ensure we have a valid cursor
      if (!currentFeed || !currentFeed.hasMore || currentFeed.isLoading) {
        if (process.env.NODE_ENV === 'development') {
          console.log(`[loadMoreFeed:${type}] Skipped - guard check failed:`, {
            hasFeed: !!currentFeed,
            hasMore: currentFeed?.hasMore,
            isLoading: currentFeed?.isLoading,
            hasCursor: !!currentFeed?.nextCursor,
            itemCount: currentFeed?.items?.length || 0
          });
        }
        return;
      }
      if (!currentFeed.nextCursor && currentFeed.items.length > 0) {
        // No cursor but we have items - something is wrong, don't load more
        if (process.env.NODE_ENV === 'development') {
          console.warn(`[loadMoreFeed:${type}] Skipped - no cursor but has ${currentFeed.items.length} items`);
        }
        return;
      }

      if (process.env.NODE_ENV === 'development') {
        console.log(`[loadMoreFeed:${type}] Starting load more:`, {
          currentItems: currentFeed.items.length,
          cursor: currentFeed.nextCursor ? 'present' : 'none',
          hasMore: currentFeed.hasMore
        });
      }

      // Set loading state immediately to prevent race conditions
      set(state => ({
        feeds: {
          ...state.feeds,
          [type]: {
            ...state.feeds[type],
            isLoading: true
          }
        }
      }));

      try {
        // Capture the cursor before making the request to ensure consistency
        const cursorAtRequestTime = currentFeed.nextCursor;
        
        const response = await feedService.getFeed({
          type,
          cursor: cursorAtRequestTime,
          limit: 20,
          filters
        } as any);
        
        set(state => {
          // Re-check state after async operation - another request might have updated it
          const currentFeedAfterAsync = state.feeds[type];
          
          // Ensure we're still using the correct cursor and haven't been superseded
          if (currentFeedAfterAsync.nextCursor !== cursorAtRequestTime && cursorAtRequestTime) {
            // Cursor has changed, another request updated the feed - discard this response
            return {
              feeds: {
                ...state.feeds,
                [type]: {
                  ...currentFeedAfterAsync,
                  isLoading: false
                }
              }
            };
          }
          
          // CRITICAL: First, deduplicate existing feed to ensure clean baseline
          // This prevents cursor issues if existing feed already had duplicates
          const cleanedExistingItems = deduplicateItems(
            currentFeedAfterAsync.items || [],
            `loadMoreFeed:${type}:cleanExisting`
          );
          
          // Transform new items from response
          const mapped = response.items?.map(item => transformToUIItem(item)) || [];
          
          // CRITICAL: Deduplicate new items first (backend might send duplicates)
          const uniqueNewItems = deduplicateItems(mapped, `loadMoreFeed:${type}:dedupNew`);
          
          // CRITICAL: Filter out items that already exist in cleaned feed
          // Build Set of existing IDs for O(1) lookup
          const existingIdsSet = new Set<string>();
          cleanedExistingItems.forEach(item => {
            const id = normalizeId(item);
            if (isValidId(id)) {
              existingIdsSet.add(id);
            }
          });
          
          // Filter new items to only include those NOT in existing feed
          const trulyNewItems = uniqueNewItems.filter(item => {
            const id = normalizeId(item);
            return isValidId(id) && !existingIdsSet.has(id);
          });
          
          // DEBUG: Log response details
          if (process.env.NODE_ENV === 'development') {
            const responseIds = mapped.map(item => normalizeId(item));
            const duplicatesInResponse = responseIds.filter((id, idx) => responseIds.indexOf(id) !== idx);
            const duplicatesAgainstExisting = uniqueNewItems
              .map(item => normalizeId(item))
              .filter(id => existingIdsSet.has(id));
            
            if (duplicatesInResponse.length > 0) {
              console.error(`[loadMoreFeed:${type}] Backend returned ${duplicatesInResponse.length} duplicate IDs in response:`, [...new Set(duplicatesInResponse)].slice(0, 10));
            }
            if (duplicatesAgainstExisting.length > 0) {
              console.warn(`[loadMoreFeed:${type}] ${duplicatesAgainstExisting.length} posts already exist in feed (filtered out):`, [...new Set(duplicatesAgainstExisting.map((id, idx) => {
                const item = uniqueNewItems[idx];
                return { id, preview: item?.content?.text?.substring(0, 50) || 'no preview' };
              }))].slice(0, 10));
            }
            
            console.log(`[loadMoreFeed:${type}] Processing:`, {
              existingItems: cleanedExistingItems.length,
              responseItems: mapped.length,
              uniqueNewItems: uniqueNewItems.length,
              duplicatesInResponse: duplicatesInResponse.length,
              duplicatesAgainstExisting: duplicatesAgainstExisting.length,
              trulyNewItems: trulyNewItems.length,
              cursor: cursorAtRequestTime ? 'present' : 'none'
            });
          }
          
          // FINAL: Merge cleaned existing + truly new items, then deduplicate one more time as safety net
          const allItems = [...cleanedExistingItems, ...trulyNewItems];
          const finalItems = deduplicateItems(allItems, `loadMoreFeed:${type}:final`);
          
          // DEBUG: Log final result
          if (process.env.NODE_ENV === 'development') {
            console.log(`[loadMoreFeed:${type}] Final merge: ${allItems.length} → ${finalItems.length} unique`, {
              cleanedExisting: cleanedExistingItems.length,
              trulyNew: trulyNewItems.length,
              beforeFinalDedup: allItems.length,
              afterFinalDedup: finalItems.length,
              removed: allItems.length - finalItems.length
            });
          }
          
          // Update cache with new items only
          try { useUsersStore.getState().primeFromPosts(mapped as any); } catch {}
          const newCache = { ...state.postsById };
          mapped.forEach((p: FeedItem) => {
            const id = normalizeId(p);
            if (id) {
              newCache[id] = p;
              primeRelatedPosts(newCache, p);
            }
          });
          
          return ({
            feeds: {
              ...state.feeds,
              [type]: {
                items: finalItems,
                hasMore: response.hasMore || false,
                nextCursor: response.nextCursor,
                totalCount: finalItems.length,
                isLoading: false,
                lastUpdated: Date.now()
              }
            },
            postsById: newCache
          });
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to load more feed';
        
        set(state => ({
          feeds: {
            ...state.feeds,
            [type]: {
              ...state.feeds[type],
              isLoading: false,
              error: errorMessage
            }
          }
        }));
      }
    },

    // Create new post
    createPost: async (request: CreatePostRequest) => {
      set({ isLoading: true, error: null });

      try {
        const response = await feedService.createPost(request);
        
        if (response.success) {
          // Add the new post to the beginning of all relevant feeds
          const newPost: FeedItem = {
            id: response.post.id,
            user: response.post.user,
            content: response.post.content || { text: '' }, // Use full content object
            date: new Date().toISOString(),
            engagement: { replies: 0, reposts: 0, likes: 0 },
            media: response.post.content?.images || [], // Keep for backward compatibility
            type: response.post.type,
            visibility: response.post.visibility,
            hashtags: response.post.hashtags || [],
            mentions: response.post.mentions || [],
            isLocalNew: true
          };

          set(state => {
            const postId = normalizeId(newPost);
            
            // Use deduplicateItems to ensure no duplicates in any feed
            // Merge new post with existing items, then deduplicate entire array
            const postsFeedItems = deduplicateItems([newPost, ...state.feeds.posts.items], 'createPost:posts');
            const mixedFeedItems = deduplicateItems([newPost, ...state.feeds.mixed.items], 'createPost:mixed');
            const forYouFeedItems = deduplicateItems([newPost, ...(state.feeds.for_you?.items || [])], 'createPost:for_you');
            
            // Log if post was already present (would be filtered by deduplicateItems)
            const wasDuplicate = 
              state.feeds.posts.items.some(item => normalizeId(item) === postId) ||
              state.feeds.mixed.items.some(item => normalizeId(item) === postId) ||
              (state.feeds.for_you?.items || []).some(item => normalizeId(item) === postId);
            
            if (wasDuplicate) {
              console.log(`[Store] createPost: Post ${postId} already exists in feeds, deduplicated`);
            }
            
            return {
              feeds: {
                ...state.feeds,
                posts: {
                  ...state.feeds.posts,
                  items: postsFeedItems,
                  totalCount: postsFeedItems.length
                },
                mixed: {
                  ...state.feeds.mixed,
                  items: mixedFeedItems,
                  totalCount: mixedFeedItems.length
                },
                for_you: {
                  ...state.feeds.for_you,
                  items: forYouFeedItems,
                  totalCount: forYouFeedItems.length
                }
              },
              postsById: { ...state.postsById, [newPost.id]: newPost },
              isLoading: false,
              lastRefresh: Date.now()
            };
          });
          try { useUsersStore.getState().upsertUser(newPost.user as any); } catch {}
          
          return newPost;
        }
        return null;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to create post';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // Create thread
    createThread: async (request: CreateThreadRequest) => {
      set({ isLoading: true, error: null });

      try {
        const response = await feedService.createThread(request);
        
        if (response.success && response.posts) {
          const newPosts: FeedItem[] = response.posts.map((post: any) => ({
            id: post.id,
            user: post.user,
            content: post.content || { text: '' },
            date: new Date().toISOString(),
            engagement: { replies: 0, reposts: 0, likes: 0 },
            media: post.content?.images || [],
            type: post.type,
            visibility: post.visibility,
            hashtags: post.hashtags || [],
            mentions: post.mentions || [],
            parentPostId: post.parentPostId,
            threadId: post.threadId,
            isLocalNew: true
          }));

          set(state => {
            // Use deduplicateItems to ensure no duplicates in any feed
            // Merge new posts with existing items, then deduplicate entire array
            const postsFeedItems = deduplicateItems([...newPosts, ...state.feeds.posts.items], 'createThread:posts');
            const mixedFeedItems = deduplicateItems([...newPosts, ...state.feeds.mixed.items], 'createThread:mixed');
            const forYouFeedItems = deduplicateItems([...newPosts, ...(state.feeds.for_you?.items || [])], 'createThread:for_you');
            
            // Log if any posts were duplicates
            const duplicateCount = newPosts.length - (
              postsFeedItems.length - state.feeds.posts.items.length +
              mixedFeedItems.length - state.feeds.mixed.items.length +
              forYouFeedItems.length - (state.feeds.for_you?.items.length || 0)
            ) / 3;
            
            if (duplicateCount > 0) {
              console.log(`[Store] createThread: ${duplicateCount} posts were duplicates, deduplicated`);
            }
            
            return {
              feeds: {
                ...state.feeds,
                posts: {
                  ...state.feeds.posts,
                  items: postsFeedItems,
                  totalCount: postsFeedItems.length
                },
                mixed: {
                  ...state.feeds.mixed,
                  items: mixedFeedItems,
                  totalCount: mixedFeedItems.length
                },
                for_you: {
                  ...state.feeds.for_you,
                  items: forYouFeedItems,
                  totalCount: forYouFeedItems.length
                }
              },
              postsById: newPosts.reduce((acc, p) => ({ ...acc, [p.id]: p }), state.postsById),
              isLoading: false,
              lastRefresh: Date.now()
            };
          });
          try { useUsersStore.getState().primeFromPosts(newPosts as any); } catch {}
          
          return newPosts;
        }
        return [];
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to create thread';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // Create reply - optimized to use updatePostEverywhere
    createReply: async (request: CreateReplyRequest) => {
      const postId = request.postId;
      let previousState: FeedItem | null = null;
      
      set({ isLoading: true, error: null });

      try {
        // Mark local action to suppress immediate echo from socket
        markLocalAction(postId, 'reply');
        
        // Optimistic update - update UI immediately
        const currentPost = get().postsById[postId];
        if (currentPost) {
          previousState = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({
            ...prev,
            engagement: { ...prev.engagement, replies: (prev.engagement.replies || 0) + 1 }
          }));
        }
        
        const response = await feedService.createReply(request);
        
        if (!response.success) {
          // Rollback on failure
          if (previousState) {
            get().updatePostEverywhere(postId, () => previousState!);
          }
          throw new Error('Failed to create reply');
        }
        
        set({ isLoading: false });
      } catch (error) {
        // Rollback optimistic update on error
        if (previousState) {
          get().updatePostEverywhere(postId, () => previousState!);
        }
        const errorMessage = error instanceof Error ? error.message : 'Failed to create reply';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // Create repost - optimized to use updatePostEverywhere
    createRepost: async (request: CreateRepostRequest) => {
      const postId = request.originalPostId;
      let previousState: FeedItem | null = null;
      
      set({ isLoading: true, error: null });

      try {
        // Optimistic update - update UI immediately
        const currentPost = get().postsById[postId];
        if (currentPost) {
          previousState = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({
            ...prev,
            engagement: { ...prev.engagement, reposts: (prev.engagement.reposts || 0) + 1 }
          }));
        }

        const response = await feedService.createRepost(request);

        if (!response.success) {
          // Rollback on failure
          if (previousState) {
            get().updatePostEverywhere(postId, () => previousState!);
          }
          throw new Error('Failed to create repost');
        }
        
        set({ isLoading: false });
      } catch (error) {
        // Rollback optimistic update on error
        if (previousState) {
          get().updatePostEverywhere(postId, () => previousState!);
        }
        const errorMessage = error instanceof Error ? error.message : 'Failed to create repost';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // Repost post (simple repost without comment) - with optimistic update
    repostPost: async (request: { postId: string }) => {
      const postId = request.postId;
      let previousState: FeedItem | null = null;
      
      try {
        markLocalAction(postId, 'repost');
        
        // Optimistic update - update UI immediately
        const currentPost = get().postsById[postId];
        if (currentPost) {
          previousState = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({
            ...prev,
            isReposted: true,
            engagement: { ...prev.engagement, reposts: (prev.engagement.reposts || 0) + 1 }
          }));
        }

        const response = await feedService.createRepost({
          originalPostId: postId,
          mentions: [],
          hashtags: []
        });

        if (!response.success) {
          // Rollback on failure
          if (previousState) {
            get().updatePostEverywhere(postId, () => previousState!);
          }
          throw new Error('Failed to repost post');
        }
      } catch (error) {
        // Rollback optimistic update on error
        if (previousState) {
          get().updatePostEverywhere(postId, () => previousState!);
        }
        const errorMessage = error instanceof Error ? error.message : 'Failed to repost post';
        set({ error: errorMessage });
        throw error;
      }
    },

    // Unrepost post - with optimistic update
    unrepostPost: async (request: { postId: string }) => {
      const postId = request.postId;
      let previousState: FeedItem | null = null;
      
      try {
        markLocalAction(postId, 'unrepost');
        
        // Optimistic update - update UI immediately
        const currentPost = get().postsById[postId];
        if (currentPost) {
          previousState = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({
            ...prev,
            isReposted: false,
            engagement: { ...prev.engagement, reposts: Math.max(0, (prev.engagement.reposts || 0) - 1) }
          }));
        }

        const response = await feedService.unrepostItem(request);

        if (!response.success) {
          // Rollback on failure
          if (previousState) {
            get().updatePostEverywhere(postId, () => previousState!);
          }
          throw new Error('Failed to unrepost post');
        }
      } catch (error) {
        // Rollback optimistic update on error
        if (previousState) {
          get().updatePostEverywhere(postId, () => previousState!);
        }
        const errorMessage = error instanceof Error ? error.message : 'Failed to unrepost post';
        set({ error: errorMessage });
        throw error;
      }
    },

    // Like post - with optimistic update
    likePost: async (request: LikeRequest) => {
      const postId = request.postId;
      let previousState: FeedItem | null = null;
      
      try {
        markLocalAction(postId, 'like');
        
        // Optimistic update - update UI immediately
        const currentPost = get().postsById[postId];
        if (currentPost) {
          previousState = { ...currentPost };
          
          // Only update if not already liked (prevent double-like)
          if (!currentPost.isLiked) {
            get().updatePostEverywhere(postId, (prev) => ({
              ...prev,
              isLiked: true,
              engagement: { ...prev.engagement, likes: (prev.engagement.likes || 0) + 1 }
            }));
          }
        }

        const response = await feedService.likeItem(request);

        if (!response.success) {
          // Rollback on failure
          if (previousState) {
            get().updatePostEverywhere(postId, () => previousState!);
          }
          throw new Error('Failed to like post');
        }
        
        // Server response has accurate count - use it to sync
        // Also ensure isLiked is set correctly based on server response
        const serverLikesCount = response.data?.likesCount;
        const serverLiked = response.data?.liked !== false; // Default to true if not specified
        
        if (serverLikesCount !== undefined) {
          get().updatePostEverywhere(postId, (prev) => {
            // Update count if different
            const countChanged = prev.engagement.likes !== serverLikesCount;
            // Update isLiked if server says different (handles race conditions)
            const stateChanged = prev.isLiked !== serverLiked;
            
            if (!countChanged && !stateChanged) return null as any;
            
            return {
              ...prev,
              isLiked: serverLiked,
              engagement: { ...prev.engagement, likes: serverLikesCount }
            };
          });
        }
      } catch (error) {
        // Rollback optimistic update on error
        if (previousState) {
          get().updatePostEverywhere(postId, () => previousState!);
        }
        const errorMessage = error instanceof Error ? error.message : 'Failed to like post';
        set({ error: errorMessage });
        throw error;
      }
    },

    // Unlike post - with optimistic update
    unlikePost: async (request: UnlikeRequest) => {
      const postId = request.postId;
      let previousState: FeedItem | null = null;
      
      try {
        markLocalAction(postId, 'unlike');
        
        // Optimistic update - update UI immediately
        const currentPost = get().postsById[postId];
        if (currentPost) {
          previousState = { ...currentPost };
          
          // Only update if currently liked (prevent double-unlike)
          if (currentPost.isLiked) {
            get().updatePostEverywhere(postId, (prev) => ({
              ...prev,
              isLiked: false,
              engagement: { ...prev.engagement, likes: Math.max(0, (prev.engagement.likes || 0) - 1) }
            }));
          }
        }

        const response = await feedService.unlikeItem(request);

        if (!response.success) {
          // Rollback on failure
          if (previousState) {
            get().updatePostEverywhere(postId, () => previousState!);
          }
          throw new Error('Failed to unlike post');
        }
        
        // Server response has accurate count - use it to sync
        // Also ensure isLiked is set correctly based on server response
        const serverLikesCount = response.data?.likesCount;
        const serverLiked = response.data?.liked === true; // Default to false if not specified
        
        if (serverLikesCount !== undefined) {
          get().updatePostEverywhere(postId, (prev) => {
            // Update count if different
            const countChanged = prev.engagement.likes !== serverLikesCount;
            // Update isLiked if server says different (handles race conditions)
            const stateChanged = prev.isLiked !== serverLiked;
            
            if (!countChanged && !stateChanged) return null as any;
            
            return {
              ...prev,
              isLiked: serverLiked,
              engagement: { ...prev.engagement, likes: serverLikesCount }
            };
          });
        }
      } catch (error) {
        // Rollback optimistic update on error
        if (previousState) {
          get().updatePostEverywhere(postId, () => previousState!);
        }
        const errorMessage = error instanceof Error ? error.message : 'Failed to unlike post';
        set({ error: errorMessage });
        throw error;
      }
    },

    // Save post - with optimistic update
    savePost: async (request: { postId: string }) => {
      const postId = request.postId;
      let previousState: FeedItem | null = null;
      
      try {
        markLocalAction(postId, 'save');
        
        // Optimistic update - update UI immediately
        const currentPost = get().postsById[postId];
        if (currentPost) {
          previousState = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({ ...prev, isSaved: true }));
        }

        const response = await feedService.saveItem(request);
        
        if (!response.success) {
          // Rollback on failure
          if (previousState) {
            get().updatePostEverywhere(postId, () => previousState!);
          }
          throw new Error('Failed to save post');
        }
      } catch (error) {
        // Rollback optimistic update on error
        if (previousState) {
          get().updatePostEverywhere(postId, () => previousState!);
        }
        const errorMessage = error instanceof Error ? error.message : 'Failed to save post';
        set({ error: errorMessage });
        throw error;
      }
    },

    // Unsave post - with optimistic update
    unsavePost: async (request: { postId: string }) => {
      const postId = request.postId;
      let previousState: FeedItem | null = null;
      
      try {
        markLocalAction(postId, 'unsave');
        
        // Optimistic update - update UI immediately
        const currentPost = get().postsById[postId];
        if (currentPost) {
          previousState = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({ ...prev, isSaved: false }));
        }

        const response = await feedService.unsaveItem(request);
        
        if (!response.success) {
          // Rollback on failure
          if (previousState) {
            get().updatePostEverywhere(postId, () => previousState!);
          }
          throw new Error('Failed to unsave post');
        }
      } catch (error) {
        // Rollback optimistic update on error
        if (previousState) {
          get().updatePostEverywhere(postId, () => previousState!);
        }
        const errorMessage = error instanceof Error ? error.message : 'Failed to unsave post';
        set({ error: errorMessage });
        throw error;
      }
    },

    // Get post by ID
    getPostById: async (postId: string) => {
      try {
        const cached = get().postsById[postId];
        if (cached) return cached;

        const response = await feedService.getPostById(postId);
        const item = transformToUIItem(response);
        set(state => {
          const newCache = { ...state.postsById, [item.id]: item } as Record<string, FeedItem>;
          primeRelatedPosts(newCache, item);
          return { postsById: newCache };
        });
        return item;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch post';
        set({ error: errorMessage });
        throw error;
      }
    },

    // Local state updates
    updatePostLocally: (postId: string, updates: Partial<FeedItem>) => {
      set(state => ({
        feeds: {
          ...state.feeds,
          posts: {
            ...state.feeds.posts,
            items: state.feeds.posts.items.map(post => 
              post.id === postId ? { ...post, ...updates } : post
            )
          },
          mixed: {
            ...state.feeds.mixed,
            items: state.feeds.mixed.items.map(post => 
              post.id === postId ? { ...post, ...updates } : post
            )
          }
        }
      }));
    },

    // Centralized deduped updater (only touches slices containing the postId)
    updatePostEverywhere: (postId: string, updater: (prev: FeedItem) => FeedItem | null | undefined) => {
      // Fast shallow comparison function for posts
      const arePostsEqual = (prev: FeedItem, next: FeedItem): boolean => {
        if (!prev || !next) return prev === next;
        return (
          prev.isLiked === next.isLiked &&
          prev.isReposted === next.isReposted &&
          prev.isSaved === next.isSaved &&
          prev.engagement?.likes === next.engagement?.likes &&
          prev.engagement?.reposts === next.engagement?.reposts &&
          prev.engagement?.replies === next.engagement?.replies
        );
      };
      
      set((state) => {
        // Prepare updated cache item, if any
        const cached = state.postsById[postId];
        const updatedCached = cached ? updater(cached) : undefined;
        const cacheChanged = updatedCached && cached && !arePostsEqual(cached, updatedCached);
        let feedsChanged = false;
        const nextFeeds = { ...state.feeds } as typeof state.feeds;
        (Object.keys(state.feeds) as (keyof typeof state.feeds)[]).forEach((ft) => {
          const slice = state.feeds[ft];
          if (!slice?.items?.length) return;
          const idx = slice.items.findIndex((p) => p.id === postId);
          if (idx === -1) return;
          const prevItem = slice.items[idx];
          const updated = updater(prevItem);
          if (!updated) return;
          
          // Fast shallow equality check - only update if data actually changed
          if (arePostsEqual(prevItem, updated)) {
            return;
          }
          
          const newItems = slice.items.slice();
          newItems[idx] = updated;
          nextFeeds[ft] = { ...slice, items: newItems } as any;
          feedsChanged = true;
        });

        // Update user feeds similarly
        let userFeedsChanged = false;
        const nextUserFeeds: typeof state.userFeeds = {} as any;
        const userIds = Object.keys(state.userFeeds || {});
        for (const uid of userIds) {
          const userSlices = state.userFeeds[uid];
          if (!userSlices) continue;
          let anySliceChanged = false;
          const nextSlices: any = {};
          (Object.keys(userSlices || {}) as FeedType[]).forEach((ft) => {
            const slice = userSlices[ft];
            if (!slice?.items?.length) { if (slice) nextSlices[ft] = slice; return; }
            const idx = slice.items.findIndex((p) => p.id === postId);
            if (idx === -1) { nextSlices[ft] = slice; return; }
            const prevItem = slice.items[idx];
            const updated = updater(prevItem);
            if (!updated) { nextSlices[ft] = slice; return; }
            
            // Fast shallow equality check - only update if data actually changed
            if (arePostsEqual(prevItem, updated)) {
              nextSlices[ft] = slice;
              return;
            }
            
            const newItems = slice.items.slice();
            newItems[idx] = updated;
            nextSlices[ft] = { ...slice, items: newItems };
            anySliceChanged = true;
          });
          nextUserFeeds[uid] = anySliceChanged ? nextSlices : userSlices;
          if (anySliceChanged) userFeedsChanged = true;
        }

        // Merge cache update last to keep entity cache fresh (only if changed)
        const nextCache = (cacheChanged && updatedCached) 
          ? { ...state.postsById, [postId]: updatedCached } 
          : state.postsById;

        // Early return if nothing changed
        if (!feedsChanged && !userFeedsChanged && !cacheChanged) {
          return state;
        }

        return {
          ...state,
          postsById: nextCache,
          feeds: feedsChanged ? nextFeeds : state.feeds,
          userFeeds: userFeedsChanged ? nextUserFeeds : state.userFeeds,
        };
      });
    },

    removePostEverywhere: (postId: string) => {
      set((state) => {
        // Remove from global feeds
        const nextFeeds: any = {};
        (Object.keys(state.feeds) as (keyof typeof state.feeds)[]).forEach((ft) => {
          const slice = state.feeds[ft];
          const filtered = slice.items.filter((p) => p.id !== postId);
          if (filtered.length !== slice.items.length) {
            nextFeeds[ft] = {
              ...slice,
              items: filtered,
              totalCount: Math.max(0, (slice.totalCount || 0) - 1),
            };
          } else {
            nextFeeds[ft] = slice;
          }
        });

        // Remove from user feeds
        const nextUserFeeds: any = {};
        Object.keys(state.userFeeds).forEach((uid) => {
          const slices = state.userFeeds[uid];
          const nextSlices: any = {};
          (Object.keys(slices) as (keyof typeof slices)[]).forEach((ft) => {
            const slice = slices[ft];
            const filtered = slice.items.filter((p) => p.id !== postId);
            if (filtered.length !== slice.items.length) {
              nextSlices[ft] = {
                ...slice,
                items: filtered,
                totalCount: Math.max(0, (slice.totalCount || 0) - 1),
              };
            } else {
              nextSlices[ft] = slice;
            }
          });
          nextUserFeeds[uid] = nextSlices;
        });

        // Remove from cache
        const nextCache = { ...state.postsById };
        delete nextCache[postId];

        return { ...state, feeds: nextFeeds, userFeeds: nextUserFeeds, postsById: nextCache };
      });
    },

    removePostLocally: (postId: string, feedType: FeedType) => {
      set(state => ({
        feeds: {
          ...state.feeds,
          [feedType]: {
            ...state.feeds[feedType],
            items: state.feeds[feedType].items.filter(post => post.id !== postId),
            totalCount: Math.max(0, state.feeds[feedType].totalCount - 1)
          }
        }
      }));
    },

    addPostToFeed: (post: FeedItem, feedType: FeedType) => {
      set(state => {
        const currentFeed = state.feeds[feedType];
        if (!currentFeed) return state;
        
        // Transform and merge, then deduplicate
        const transformedPost = transformToUIItem(post);
        const mergedItems = [transformedPost, ...currentFeed.items];
        const finalItems = deduplicateItems(mergedItems, `addPostToFeed:${feedType}`);
        
        // Update cache
        const newCache = { ...state.postsById };
        const postId = normalizeId(transformedPost);
        if (postId) {
          newCache[postId] = transformedPost;
          primeRelatedPosts(newCache, transformedPost);
        }
        
        try { useUsersStore.getState().primeFromPosts([transformedPost] as any); } catch {}
        
        return {
          ...state,
          feeds: {
            ...state.feeds,
            [feedType]: {
              ...currentFeed,
              items: finalItems,
              totalCount: finalItems.length,
              lastUpdated: Date.now()
            }
          },
          postsById: newCache
        };
      });
    },

    addPostsToFeed: (posts: FeedItem[], feedType: FeedType) => {
      if (!posts || posts.length === 0) return;
      
      set(state => {
        const currentFeed = state.feeds[feedType];
        if (!currentFeed) return state;
        
        // Transform posts
        const transformedPosts = posts.map(p => transformToUIItem(p));
        
        // Merge with existing and deduplicate entire array
        const mergedItems = [...transformedPosts, ...currentFeed.items];
        const finalItems = deduplicateItems(mergedItems, `addPostsToFeed:${feedType}`);
        
        // Update cache
        const newCache = { ...state.postsById };
        transformedPosts.forEach((p: FeedItem) => {
          const id = normalizeId(p);
          if (id) {
            newCache[id] = p;
            primeRelatedPosts(newCache, p);
          }
        });
        
        try { useUsersStore.getState().primeFromPosts(transformedPosts as any); } catch {}
        
        return {
          ...state,
          feeds: {
            ...state.feeds,
            [feedType]: {
              ...currentFeed,
              items: finalItems,
              totalCount: finalItems.length,
              lastUpdated: Date.now()
            }
          },
          postsById: newCache
        };
      });
    },

    // Utility actions
    clearError: () => set({ error: null }),
    
    clearFeed: (type: FeedType) => {
      set(state => ({
        feeds: {
          ...state.feeds,
          [type]: createDefaultFeedState()
        }
      }));
    },

    clearUserFeed: (userId: string, type: FeedType) => {
      set(state => ({
        userFeeds: {
          ...state.userFeeds,
          [userId]: {
            ...state.userFeeds[userId],
            [type]: createDefaultFeedState()
          }
        }
      }));
    }
  }))
);

// Selectors for better performance - return stable references when data hasn't meaningfully changed
export const useFeedSelector = (type: FeedType) => {
  const feed = usePostsStore(state => state.feeds[type]);
  return feed || {
    items: [],
    hasMore: true,
    nextCursor: undefined,
    totalCount: 0,
    isLoading: false,
    error: null,
    lastUpdated: 0,
    filters: undefined
  };
};

export const useUserFeedSelector = (userId: string, type: FeedType) => {
  const feed = usePostsStore(state => state.userFeeds[userId]?.[type]);
  return feed || {
    items: [],
    hasMore: true,
    nextCursor: undefined,
    totalCount: 0,
    isLoading: false,
    error: null,
    lastUpdated: 0
  };
};

export const useFeedLoading = (type: FeedType) => 
  usePostsStore(state => state.feeds[type]?.isLoading || false);

export const useFeedError = (type: FeedType) => 
  usePostsStore(state => state.feeds[type]?.error);

export const useFeedHasMore = (type: FeedType) => 
  usePostsStore(state => state.feeds[type]?.hasMore || false); 
