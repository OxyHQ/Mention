import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { 
  FeedRequest, 
  FeedResponse, 
  CreateReplyRequest, 
  CreateRepostRequest, 
  CreatePostRequest, 
  LikeRequest, 
  UnlikeRequest,
  FeedType,
  Post as DomainPost
} from '@mention/shared-types';
import { feedService } from '../services/feedService';

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
  content: string;
  date: string;
  engagement: {
    replies: number;
    reposts: number;
    likes: number;
  };
  media?: string[];
  isLiked?: boolean;
  isReposted?: boolean;
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
  
  // Global state
  isLoading: boolean;
  error: string | null;
  lastRefresh: number;
  
  // Actions
  // Feed management
  fetchFeed: (request: FeedRequest) => Promise<void>;
  fetchUserFeed: (userId: string, request: FeedRequest) => Promise<void>;
  refreshFeed: (type: FeedType) => Promise<void>;
  loadMoreFeed: (type: FeedType) => Promise<void>;
  
  // Post actions
  createPost: (request: CreatePostRequest) => Promise<void>;
  createReply: (request: CreateReplyRequest) => Promise<void>;
  createRepost: (request: CreateRepostRequest) => Promise<void>;
  likePost: (request: LikeRequest) => Promise<void>;
  unlikePost: (request: UnlikeRequest) => Promise<void>;
  savePost: (request: { postId: string }) => Promise<void>;
  unsavePost: (request: { postId: string }) => Promise<void>;
  getPostById: (postId: string) => Promise<any>;
  
  // Local state updates
  updatePostLocally: (postId: string, updates: Partial<FeedItem>) => void;
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
  mixed: createDefaultFeedState()
});

export const usePostsStore = create<FeedState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    feeds: createDefaultFeedsState(),
    userFeeds: {},
    isLoading: false,
    error: null,
    lastRefresh: Date.now(),

    // Fetch main feed
    fetchFeed: async (request: FeedRequest) => {
      const { type = 'mixed' } = request;
      
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
        const response = await feedService.getFeed(request);
        
        set(state => ({
          feeds: {
            ...state.feeds,
            [type]: {
              items: response.items?.map(item => item.data) || [],
              hasMore: response.hasMore || false,
              nextCursor: response.nextCursor,
              totalCount: response.totalCount || 0,
              isLoading: false,
              error: null,
              lastUpdated: Date.now()
            }
          },
          lastRefresh: Date.now()
        }));
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
        
        set(state => ({
          userFeeds: {
            ...state.userFeeds,
            [userId]: {
              ...state.userFeeds[userId],
              [type]: {
                items: response.items?.map(item => item.data) || [],
                hasMore: response.hasMore || false,
                nextCursor: response.nextCursor,
                totalCount: response.totalCount || 0,
                isLoading: false,
                error: null,
                lastUpdated: Date.now()
              }
            }
          }
        }));
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

    // Refresh feed (pull to refresh)
    refreshFeed: async (type: FeedType) => {
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
          limit: currentFeed.items.length || 20
        });

        set(state => ({
          feeds: {
            ...state.feeds,
            [type]: {
              items: response.items?.map(item => item.data) || [],
              hasMore: response.hasMore || false,
              nextCursor: response.nextCursor,
              totalCount: response.totalCount || 0,
              isLoading: false,
              error: null,
              lastUpdated: Date.now()
            }
          },
          lastRefresh: Date.now()
        }));
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
    loadMoreFeed: async (type: FeedType) => {
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
          limit: 20
        });

        set(state => ({
          feeds: {
            ...state.feeds,
            [type]: {
              items: [...state.feeds[type].items, ...(response.items?.map(item => item.data) || [])],
              hasMore: response.hasMore || false,
              nextCursor: response.nextCursor,
              totalCount: state.feeds[type].totalCount + (response.items?.length || 0),
              isLoading: false,
              lastUpdated: Date.now()
            }
          }
        }));
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
            content: response.post.content?.text || '',
            date: new Date().toISOString(),
            engagement: { replies: 0, reposts: 0, likes: 0 },
            media: response.post.content?.images || [],
            type: response.post.type,
            visibility: response.post.visibility,
            hashtags: response.post.hashtags || [],
            mentions: response.post.mentions || []
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
              }
            },
            isLoading: false,
            lastRefresh: Date.now()
          }));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to create post';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // Create reply
    createReply: async (request: CreateReplyRequest) => {
      set({ isLoading: true, error: null });

      try {
        const response = await feedService.createReply(request);
        
        if (response.success) {
          // Update the parent post's reply count locally
          set(state => ({
            feeds: {
              ...state.feeds,
              posts: {
                ...state.feeds.posts,
                items: state.feeds.posts.items.map(post => 
                  post.id === request.postId
                    ? { ...post, engagement: { ...post.engagement, replies: post.engagement.replies + 1 } }
                    : post
                )
              },
              mixed: {
                ...state.feeds.mixed,
                items: state.feeds.mixed.items.map(post => 
                  post.id === request.postId
                    ? { ...post, engagement: { ...post.engagement, replies: post.engagement.replies + 1 } }
                    : post
                )
              }
            },
            isLoading: false
          }));
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
          set(state => ({
            feeds: {
              ...state.feeds,
              posts: {
                ...state.feeds.posts,
                items: state.feeds.posts.items.map(post => 
                  post.id === request.originalPostId
                    ? { ...post, engagement: { ...post.engagement, reposts: post.engagement.reposts + 1 } }
                    : post
                )
              },
              mixed: {
                ...state.feeds.mixed,
                items: state.feeds.mixed.items.map(post => 
                  post.id === request.postId
                    ? { ...post, engagement: { ...post.engagement, reposts: post.engagement.reposts + 1 } }
                    : post
                )
              }
            },
            isLoading: false
          }));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to create repost';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // Like post
    likePost: async (request: LikeRequest) => {
      try {
        const response = await feedService.likeItem(request);
        
        if (response.success) {
          // Update post like state locally
          set(state => ({
            feeds: {
              ...state.feeds,
              posts: {
                ...state.feeds.posts,
                items: state.feeds.posts.items.map(post => 
                  post.id === request.postId 
                    ? { 
                        ...post, 
                        isLiked: true,
                        engagement: { ...post.engagement, likes: post.engagement.likes + 1 }
                      }
                    : post
                )
              },
              mixed: {
                ...state.feeds.mixed,
                items: state.feeds.mixed.items.map(post => 
                  post.id === request.postId
                    ? { 
                        ...post, 
                        isLiked: true,
                        engagement: { ...post.engagement, likes: post.engagement.likes + 1 }
                      }
                    : post
                )
              }
            }
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
        const response = await feedService.unlikeItem(request);
        
        if (response.success) {
          // Update post like state locally
          set(state => ({
            feeds: {
              ...state.feeds,
              posts: {
                ...state.feeds.posts,
                items: state.feeds.posts.items.map(post => 
                  post.id === request.postId 
                    ? { 
                        ...post, 
                        isLiked: false,
                        engagement: { ...post.engagement, likes: Math.max(0, post.engagement.likes - 1) }
                      }
                    : post
                )
              },
              mixed: {
                ...state.feeds.mixed,
                items: state.feeds.mixed.items.map(post => 
                  post.id === request.postId
                    ? { 
                        ...post, 
                        isLiked: false,
                        engagement: { ...post.engagement, likes: Math.max(0, post.engagement.likes - 1) }
                      }
                    : post
                )
              }
            }
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
        const response = await feedService.saveItem(request);
        
        if (response.success) {
          // Update post save state locally
          set(state => ({
            feeds: {
              ...state.feeds,
              posts: {
                ...state.feeds.posts,
                items: state.feeds.posts.items.map(post => 
                  post.id === request.postId 
                    ? { ...post, isSaved: true }
                    : post
                )
              },
              mixed: {
                ...state.feeds.mixed,
                items: state.feeds.mixed.items.map(post => 
                  post.id === request.postId
                    ? { ...post, isSaved: true }
                    : post
                )
              }
            }
          }));
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
        const response = await feedService.unsaveItem(request);
        
        if (response.success) {
          // Update post save state locally
          set(state => ({
            feeds: {
              ...state.feeds,
              posts: {
                ...state.feeds.posts,
                items: state.feeds.posts.items.map(post => 
                  post.id === request.postId 
                    ? { ...post, isSaved: false }
                    : post
                )
              },
              mixed: {
                ...state.feeds.mixed,
                items: state.feeds.mixed.items.map(post => 
                  post.id === request.postId
                    ? { ...post, isSaved: false }
                    : post
                )
              }
            }
          }));
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
        const response = await feedService.getPostById(postId);
        return response;
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