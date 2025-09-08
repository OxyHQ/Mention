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
import { markLocalAction } from '../services/echoGuard';

// Types for the store
interface FeedItem {
  id: string;
  user: {
    id: string;
    name: string;
    handle: string;
    avatar: string;
    verified: boolean;
  };
  content: PostContent; // Use full PostContent structure instead of just string
  date: string;
  engagement: {
    replies: number;
    reposts: number;
    likes: number;
  };
  media?: string[]; // Keep for backward compatibility
  // Normalized media fields from backend (if available)
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
  // Client-only flag to prioritize new self posts
  isLocalNew?: boolean;
}

interface FeedState {
  // Feed data
  feeds: Record<FeedType, {
    items: FeedItem[];
    hasMore: boolean;
    nextCursor?: string;
    totalCount: number;
    isLoading: boolean;
    error: string | null;
    lastUpdated: number;
  }>;
  
  // User profile feeds
  userFeeds: Record<string, Record<FeedType, {
    items: FeedItem[];
    hasMore: boolean;
    nextCursor?: string;
    totalCount: number;
    isLoading: boolean;
    error: string | null;
    lastUpdated: number;
  }>>;

  // Entity cache for posts not present in current feeds
  postsById: Record<string, FeedItem>;
  
  // Global state
  isLoading: boolean;
  error: string | null;
  lastRefresh: number;
  
  // Actions
  // Feed management
  fetchFeed: (request: FeedRequest) => Promise<void>;
  fetchUserFeed: (userId: string, request: FeedRequest) => Promise<void>;
  fetchSavedPosts: (request: { page?: number; limit?: number }) => Promise<void>;
  refreshFeed: (type: FeedType, filters?: Record<string, any>) => Promise<void>;
  loadMoreFeed: (type: FeedType, filters?: Record<string, any>) => Promise<void>;
  
  // Post actions
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
  // Centralized deduped updater: updates postsById, all feeds, and userFeeds
  updatePostEverywhere: (
    postId: string,
    updater: (prev: FeedItem) => FeedItem | null | undefined
  ) => void;
  removePostLocally: (postId: string, feedType: FeedType) => void;
  addPostToFeed: (post: FeedItem, feedType: FeedType) => void;
  
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
  mixed: createDefaultFeedState(),
  for_you: createDefaultFeedState(),
  following: createDefaultFeedState(),
});

// Normalize backend payload to UI-friendly shape
const transformToUIItem = (raw: any) => {
  const engagement = raw?.engagement || {
    replies: raw?.stats?.commentsCount || 0,
    reposts: raw?.stats?.repostsCount || 0,
    likes: raw?.stats?.likesCount || 0,
  };

  return {
    ...raw,
    id: String(raw?.id || raw?._id),
    content: raw?.content || { text: '' }, // Keep full content object
  mediaIds: raw?.mediaIds,
  originalMediaIds: raw?.originalMediaIds,
  allMediaIds: raw?.allMediaIds,
    isSaved: raw?.isSaved !== undefined ? raw.isSaved : (raw?.metadata?.isSaved ?? false),
    isLiked: raw?.isLiked !== undefined ? raw.isLiked : (raw?.metadata?.isLiked ?? false),
    isReposted: raw?.isReposted !== undefined ? raw.isReposted : (raw?.metadata?.isReposted ?? false),
    // Map aliases expected by components
    postId: raw?.postId || raw?.parentPostId,
    originalPostId: raw?.originalPostId || raw?.repostOf,
    engagement,
  };
};

export const usePostsStore = create<FeedState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    feeds: createDefaultFeedsState(),
    userFeeds: {},
  postsById: {},
    isLoading: false,
    error: null,
    lastRefresh: Date.now(),

    // Fetch main feed
    fetchFeed: async (request: FeedRequest) => {
      const { type = 'mixed' } = request;
      console.log('🚀 PostsStore.fetchFeed called with request:', request);
      
      set(state => ({
        feeds: {
          ...state.feeds,
          [type]: {
            ...state.feeds[type],
            isLoading: true,
            error: null
          }
        }
      }));

      try {
        console.log('📞 Calling feedService.getFeed...');
        const response = await feedService.getFeed(request);
        console.log('📦 FeedService response:', response);
        
        set(state => {
          const items = response.items?.map(item => transformToUIItem(item)) || [];
          const newCache = { ...state.postsById };
          items.forEach(p => {
            newCache[p.id] = p;
          });
          return ({
            feeds: {
              ...state.feeds,
              [type]: {
                items,
                hasMore: response.hasMore || false,
                nextCursor: response.nextCursor,
                totalCount: response.totalCount || 0,
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

    // Fetch user profile feed
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

          let mergedItems: FeedItem[] = mapped;
          let addedCount = mapped.length;
          if (request.cursor) {
            const seen = new Set((prev.items || []).map(p => p.id));
            const uniqueNew = mapped.filter(p => !seen.has(p.id));
            mergedItems = (prev.items || []).concat(uniqueNew);
            addedCount = uniqueNew.length;
          }

          // Update cache for everything we saw
          const newCache = { ...state.postsById };
          mapped.forEach(p => { newCache[p.id] = p; });

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
                  items: mergedItems,
                  hasMore: safeHasMore,
                  nextCursor,
                  totalCount: mergedItems.length,
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

    // Fetch saved posts
    fetchSavedPosts: async (request: { page?: number; limit?: number } = {}) => {
      set(state => ({
        feeds: {
          ...state.feeds,
          posts: {
            ...state.feeds.posts,
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
          const types: FeedType[] = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes'];
          const seen = new Set<string>();
          const localSaved: FeedItem[] = [];
          types.forEach(t => {
            state.feeds[t]?.items?.forEach((p: any) => {
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

        console.log('Store: Setting posts in store:', processedPosts.length, 'posts');

        set(state => {
          const newCache = { ...state.postsById };
          processedPosts.forEach((p: FeedItem) => { newCache[p.id] = p; });

          return ({
            feeds: {
              ...state.feeds,
              posts: {
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
            posts: {
              ...state.feeds.posts,
              isLoading: false,
              error: errorMessage
            }
          },
          error: errorMessage
        }));
      }
    },

    // Refresh feed (pull to refresh)
    refreshFeed: async (type: FeedType, filters?: Record<string, any>) => {
      const state = get();
      const currentFeed = state.feeds[type];
      
      if (!currentFeed) return;

      set(state => ({
        feeds: {
          ...state.feeds,
          [type]: {
            ...state.feeds[type],
            isLoading: true,
            error: null
          }
        }
      }));

      try {
        const response = await feedService.getFeed({
          type,
          limit: currentFeed.items.length || 20,
          filters
        } as any);

        set(state => {
          const items = response.items?.map(item => transformToUIItem(item)) || [];
          const newCache = { ...state.postsById };
          items.forEach((p: FeedItem) => { newCache[p.id] = p; });

          return ({
            feeds: {
              ...state.feeds,
              [type]: {
                items,
                hasMore: response.hasMore || false,
                nextCursor: response.nextCursor,
                totalCount: response.totalCount || 0,
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
      
      if (!currentFeed || !currentFeed.hasMore || currentFeed.isLoading) return;

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
        const response = await feedService.getFeed({
          type,
          cursor: currentFeed.nextCursor,
          limit: 20,
          filters
        } as any);

        set(state => {
          const mapped = response.items?.map(item => transformToUIItem(item)) || [];
          const newCache = { ...state.postsById };
          mapped.forEach((p: FeedItem) => { newCache[p.id] = p; });

          return ({
            feeds: {
              ...state.feeds,
              [type]: {
                items: [
                  ...state.feeds[type].items,
                  ...mapped
                ],
                hasMore: response.hasMore || false,
                nextCursor: response.nextCursor,
                totalCount: state.feeds[type].totalCount + (response.items?.length || 0),
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

          set(state => ({
            feeds: {
              ...state.feeds,
              posts: {
                ...state.feeds.posts,
                items: [newPost, ...state.feeds.posts.items],
                totalCount: state.feeds.posts.totalCount + 1
              },
              mixed: {
                ...state.feeds.mixed,
                items: [newPost, ...state.feeds.mixed.items],
                totalCount: state.feeds.mixed.totalCount + 1
              },
              for_you: {
                ...state.feeds.for_you,
                items: [newPost, ...(state.feeds.for_you?.items || [])],
                totalCount: (state.feeds.for_you?.totalCount || 0) + 1
              }
            },
            postsById: { ...state.postsById, [newPost.id]: newPost },
            isLoading: false,
            lastRefresh: Date.now()
          }));
          
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

          set(state => ({
            feeds: {
              ...state.feeds,
              posts: {
                ...state.feeds.posts,
                items: [...newPosts, ...state.feeds.posts.items],
                totalCount: state.feeds.posts.totalCount + newPosts.length
              },
              mixed: {
                ...state.feeds.mixed,
                items: [...newPosts, ...state.feeds.mixed.items],
                totalCount: state.feeds.mixed.totalCount + newPosts.length
              },
              for_you: {
                ...state.feeds.for_you,
                items: [...newPosts, ...(state.feeds.for_you?.items || [])],
                totalCount: (state.feeds.for_you?.totalCount || 0) + newPosts.length
              }
            },
            postsById: newPosts.reduce((acc, p) => ({ ...acc, [p.id]: p }), state.postsById),
            isLoading: false,
            lastRefresh: Date.now()
          }));
          
          return newPosts;
        }
        return [];
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to create thread';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // Create reply
    createReply: async (request: CreateReplyRequest) => {
      set({ isLoading: true, error: null });

      try {
  // Mark local action to suppress immediate echo from socket
  markLocalAction(request.postId, 'reply');
        const response = await feedService.createReply(request);
        
        if (response.success) {
          // Update the parent post's reply count locally
          set(state => {
            const postId = request.postId;
            const updatedCache = state.postsById[postId]
              ? {
                  ...state.postsById,
                  [postId]: {
                    ...state.postsById[postId],
                    engagement: {
                      ...state.postsById[postId].engagement,
                      replies: state.postsById[postId].engagement.replies + 1
                    }
                  }
                }
              : state.postsById;

            return ({
              feeds: {
                ...state.feeds,
                posts: {
                  ...state.feeds.posts,
                  items: state.feeds.posts.items.map(post => 
                    post.id === postId
                      ? { ...post, engagement: { ...post.engagement, replies: post.engagement.replies + 1 } }
                      : post
                  )
                },
                mixed: {
                  ...state.feeds.mixed,
                  items: state.feeds.mixed.items.map(post => 
                    post.id === postId
                      ? { ...post, engagement: { ...post.engagement, replies: post.engagement.replies + 1 } }
                      : post
                  )
                }
              },
              isLoading: false,
              postsById: updatedCache
            });
          });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to create reply';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // Create repost
    createRepost: async (request: CreateRepostRequest) => {
      set({ isLoading: true, error: null });

      try {
        const response = await feedService.createRepost(request);

        if (response.success) {
          // Update the original post's repost count locally
          set(state => {
            const pid = request.originalPostId;
            const updatedCache = state.postsById[pid]
              ? {
                  ...state.postsById,
                  [pid]: {
                    ...state.postsById[pid],
                    engagement: {
                      ...state.postsById[pid].engagement,
                      reposts: state.postsById[pid].engagement.reposts + 1
                    }
                  }
                }
              : state.postsById;

            return ({
              feeds: {
                ...state.feeds,
                posts: {
                  ...state.feeds.posts,
                  items: state.feeds.posts.items.map(post =>
                    post.id === pid
                      ? { ...post, engagement: { ...post.engagement, reposts: post.engagement.reposts + 1 } }
                      : post
                  )
                },
                mixed: {
                  ...state.feeds.mixed,
                  items: state.feeds.mixed.items.map(post =>
                    post.id === pid
                      ? { ...post, engagement: { ...post.engagement, reposts: post.engagement.reposts + 1 } }
                      : post
                  )
                }
              },
              isLoading: false,
              postsById: updatedCache
            });
          });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to create repost';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // Repost post (simple repost without comment)
    repostPost: async (request: { postId: string }) => {
      try {
  markLocalAction(request.postId, 'repost');
        const response = await feedService.createRepost({
          originalPostId: request.postId,
          mentions: [],
          hashtags: []
        });

        if (response.success) {
          get().updatePostEverywhere(request.postId, (prev) => ({
            ...prev,
            isReposted: true,
            engagement: { ...prev.engagement, reposts: (prev.engagement.reposts || 0) + 1 }
          }));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to repost post';
        set({ error: errorMessage });
        throw error;
      }
    },

    // Unrepost post
    unrepostPost: async (request: { postId: string }) => {
      try {
        console.log('🔄 PostsStore.unrepostPost called with:', request);
  markLocalAction(request.postId, 'unrepost');
        const response = await feedService.unrepostItem(request);
        console.log('✅ Unrepost response:', response);

        if (response.success) {
          get().updatePostEverywhere(request.postId, (prev) => ({
            ...prev,
            isReposted: false,
            engagement: { ...prev.engagement, reposts: Math.max(0, (prev.engagement.reposts || 0) - 1) }
          }));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to unrepost post';
        set({ error: errorMessage });
        throw error;
      }
    },

    // Like post
    likePost: async (request: LikeRequest) => {
      try {
  markLocalAction(request.postId, 'like');
        const response = await feedService.likeItem(request);

        if (response.success) {
          get().updatePostEverywhere(request.postId, (prev) => ({
            ...prev,
            isLiked: true,
            engagement: { ...prev.engagement, likes: (prev.engagement.likes || 0) + 1 }
          }));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to like post';
        set({ error: errorMessage });
        throw error;
      }
    },

    // Unlike post
    unlikePost: async (request: UnlikeRequest) => {
      try {
  markLocalAction(request.postId, 'unlike');
        const response = await feedService.unlikeItem(request);

        if (response.success) {
          get().updatePostEverywhere(request.postId, (prev) => ({
            ...prev,
            isLiked: false,
            engagement: { ...prev.engagement, likes: Math.max(0, (prev.engagement.likes || 0) - 1) }
          }));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to unlike post';
        set({ error: errorMessage });
        throw error;
      }
    },

    // Save post
    savePost: async (request: { postId: string }) => {
      try {
        console.log('💾 PostsStore.savePost called with:', request);
  markLocalAction(request.postId, 'save');
        const response = await feedService.saveItem(request);
        console.log('✅ Save response:', response);
        
        if (response.success) {
          get().updatePostEverywhere(request.postId, (prev) => ({ ...prev, isSaved: true }));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to save post';
        set({ error: errorMessage });
        throw error;
      }
    },

    // Unsave post
    unsavePost: async (request: { postId: string }) => {
      try {
        console.log('🗑️ PostsStore.unsavePost called with:', request);
  markLocalAction(request.postId, 'unsave');
        const response = await feedService.unsaveItem(request);
        console.log('✅ Unsave response:', response);
        
        if (response.success) {
          get().updatePostEverywhere(request.postId, (prev) => ({ ...prev, isSaved: false }));
        }
      } catch (error) {
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
        set(state => ({ postsById: { ...state.postsById, [item.id]: item } }));
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
      set((state) => {
        // Prepare updated cache item, if any
        const cached = state.postsById[postId];
        const updatedCached = cached ? updater(cached) : undefined;

        // Update main feeds per-slice using each slice's own item to avoid shape loss (e.g., repost wrappers)
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
            const newItems = slice.items.slice();
            newItems[idx] = updated;
            nextSlices[ft] = { ...slice, items: newItems };
            anySliceChanged = true;
          });
          nextUserFeeds[uid] = anySliceChanged ? nextSlices : userSlices;
          if (anySliceChanged) userFeedsChanged = true;
        }

        // Merge cache update last to keep entity cache fresh
        const nextCache = updatedCached ? { ...state.postsById, [postId]: updatedCached } : state.postsById;

        return {
          ...state,
          postsById: nextCache,
          feeds: feedsChanged ? nextFeeds : state.feeds,
          userFeeds: userFeedsChanged ? nextUserFeeds : state.userFeeds,
        };
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
      set(state => ({
        feeds: {
          ...state.feeds,
          [feedType]: {
            ...state.feeds[feedType],
            items: [post, ...state.feeds[feedType].items],
            totalCount: state.feeds[feedType].totalCount + 1
          }
        }
      }));
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

// Selectors for better performance
export const useFeedSelector = (type: FeedType) => 
  usePostsStore(state => state.feeds[type]);

export const useUserFeedSelector = (userId: string, type: FeedType) => 
  usePostsStore(state => state.userFeeds[userId]?.[type]);

export const useFeedLoading = (type: FeedType) => 
  usePostsStore(state => state.feeds[type]?.isLoading || false);

export const useFeedError = (type: FeedType) => 
  usePostsStore(state => state.feeds[type]?.error);

export const useFeedHasMore = (type: FeedType) => 
  usePostsStore(state => state.feeds[type]?.hasMore || false); 
