import { create } from 'zustand';
import { Post, Reply, FeedRepost as Repost, FeedRequest, FeedResponse, CreateReplyRequest, CreateRepostRequest, LikeRequest, UnlikeRequest } from '@mention/shared-types';
import { feedApi } from '../utils/api';



interface PostsState {
  posts: Post[];
  replies: Reply[];
  reposts: Repost[];
  isLoading: boolean;
  error: string | null;
  
  // Post Actions
  addPost: (post: Omit<Post, 'id' | 'date'>) => void;
  updatePost: (id: string, updates: Partial<Post>) => void;
  deletePost: (id: string) => void;
  likePost: (id: string) => void;
  unlikePost: (id: string) => void;
  repost: (id: string) => void;
  
  // Reply Actions
  addReply: (reply: Omit<Reply, 'id' | 'date'>) => void;
  updateReply: (id: string, updates: Partial<Reply>) => void;
  deleteReply: (id: string) => void;
  likeReply: (id: string) => void;
  unlikeReply: (id: string) => void;
  getRepliesForPost: (postId: string) => Reply[];
  
  // Repost Actions
  addRepost: (repost: Omit<Repost, 'id' | 'date'>) => void;
  deleteRepost: (id: string) => void;
  likeRepost: (id: string) => void;
  unlikeRepost: (id: string) => void;
  getRepostsForPost: (postId: string) => Repost[];
  
  // API Integration Actions
  fetchFeed: (request: FeedRequest) => Promise<void>;
  createReplyAPI: (request: CreateReplyRequest) => Promise<void>;
  createRepostAPI: (request: CreateRepostRequest) => Promise<void>;
  likeItemAPI: (request: LikeRequest) => Promise<void>;
  unlikeItemAPI: (request: UnlikeRequest) => Promise<void>;
  
  // Utility Actions
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
}

export const usePostsStore = create<PostsState>((set, get) => ({
  posts: [
    {
      id: '1',
      user: {
        name: 'Eren Arica',
        handle: 'imeronn',
        avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
        verified: true,
      },
      content: "Text slide animation in @reactnative @expo😷\n\nw/@swmansion's reanimated + expo-blur 🔥\nproduct/ ordio.com 💙",
      date: '29.04.25',
      engagement: { replies: 30, reposts: 82, likes: 1300 },
    },
    {
      id: '2',
      user: {
        name: 'Eren Arica',
        handle: 'imeronn',
        avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
        verified: true,
      },
      content: 'Building landing components just got easier! 🚀\n\n@landingcomps is the fastest way to ship beautiful landing pages. Pre-built, customizable, and React-ready.',
      date: '28.04.25',
      engagement: { replies: 45, reposts: 112, likes: 890 },
    },
    {
      id: '3',
      user: {
        name: 'Eren Arica',
        handle: 'imeronn',
        avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
        verified: true,
      },
      content: 'AI prompt engineering made simple ✨\n\n@niceprompt helps you craft better prompts and get better results from AI. Game changer for productivity!',
      date: '27.04.25',
      engagement: { replies: 67, reposts: 201, likes: 1450 },
    },
    {
      id: '4',
      user: {
        name: 'Eren Arica',
        handle: 'imeronn',
        avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
        verified: true,
      },
      content: 'Ship faster, design better 🎯\n\nCombining @landingcomps + @niceprompt workflow has 10x my productivity. From idea to shipped product in hours, not days.',
      date: '26.04.25',
      engagement: { replies: 89, reposts: 324, likes: 2100 },
    },
    {
      id: '5',
      user: {
        name: 'Eren Arica',
        handle: 'imeronn',
        avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
        verified: true,
      },
      content: 'Just dropped a new React Native animation tutorial on YouTube! 📹\n\nCovers advanced Reanimated 3 techniques and performance optimization tips. Link in bio 👆',
      date: '25.04.25',
      engagement: { replies: 156, reposts: 445, likes: 2890 },
    },
  ],
  replies: [
    {
      id: 'r1',
      postId: '1',
      user: {
        name: 'Sarah Chen',
        handle: 'sarahdesigns',
        avatar: 'https://images.unsplash.com/photo-1494790108755-2616b612b786?w=100&h=100&fit=crop&crop=face',
        verified: false,
      },
      content: 'Amazing animation! How did you handle the performance optimization?',
      date: '2h',
      engagement: { replies: 0, reposts: 0, likes: 12 },
    },
    {
      id: 'r2',
      postId: '1',
      user: {
        name: 'Alex Turner',
        handle: 'alexcodes',
        avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=face',
        verified: true,
      },
      content: 'This is exactly what I needed for my project! Thanks for sharing the technique.',
      date: '4h',
      engagement: { replies: 0, reposts: 0, likes: 8 },
    },
    {
      id: 'r3',
      postId: '2',
      user: {
        name: 'Maya Patel',
        handle: 'mayauxui',
        avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=100&h=100&fit=crop&crop=face',
        verified: false,
      },
      content: 'Landing components are a game changer! Do you have any recommendations for design systems?',
      date: '6h',
      engagement: { replies: 0, reposts: 0, likes: 15 },
    },
  ],
  reposts: [
    {
      id: 'rp1',
      originalPostId: '1',
      user: {
        name: 'David Kim',
        handle: 'davidtech',
        avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100&h=100&fit=crop&crop=face',
        verified: true,
      },
      date: '1h',
      engagement: { replies: 0, reposts: 0, likes: 0 },
    },
    {
      id: 'rp2',
      originalPostId: '2',
      user: {
        name: 'Emma Johnson',
        handle: 'emmawrites',
        avatar: 'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?w=100&h=100&fit=crop&crop=face',
        verified: false,
      },
      date: '3h',
      engagement: { replies: 0, reposts: 0, likes: 0 },
    },
  ],
  isLoading: false,
  error: null,

  addPost: (postData) => {
    const newPost: UIPost = {
      id: Date.now().toString(),
      date: new Date().toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric' 
      }),
      ...postData,
    };

    set((state) => ({
      posts: [newPost, ...state.posts],
    }));
  },

  updatePost: (id, updates) => {
    set((state) => ({
      posts: state.posts.map((post) =>
        post.id === id ? { ...post, ...updates } : post
      ),
    }));
  },

  deletePost: (id) => {
    set((state) => ({
      posts: state.posts.filter((post) => post.id !== id),
    }));
  },

  likePost: (id) => {
    set((state) => ({
      posts: state.posts.map((post) =>
        post.id === id
          ? {
              ...post,
              engagement: {
                ...post.engagement,
                likes: post.engagement.likes + 1,
              },
            }
          : post
      ),
    }));
  },

  unlikePost: (id) => {
    set((state) => ({
      posts: state.posts.map((post) =>
        post.id === id
          ? {
              ...post,
              engagement: {
                ...post.engagement,
                likes: Math.max(0, post.engagement.likes - 1),
              },
            }
          : post
      ),
    }));
  },

  repost: (id) => {
    // This is now handled by addRepost for creating actual repost records
    // This function is kept for backward compatibility
    set((state) => ({
      posts: state.posts.map((post) =>
        post.id === id
          ? {
              ...post,
              engagement: {
                ...post.engagement,
                reposts: post.engagement.reposts + 1,
              },
            }
          : post
      ),
    }));
  },

  setLoading: (loading) => {
    set({ isLoading: loading });
  },

  setError: (error) => {
    set({ error });
  },

  clearError: () => {
    set({ error: null });
  },

  // Reply Actions
  addReply: (replyData) => {
    const newReply: Reply = {
      id: Date.now().toString(),
      date: new Date().toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric' 
      }),
      ...replyData,
    };

    set((state) => ({
      replies: [newReply, ...state.replies],
      posts: state.posts.map((post) =>
        post.id === replyData.postId
          ? {
              ...post,
              engagement: {
                ...post.engagement,
                replies: post.engagement.replies + 1,
              },
            }
          : post
      ),
    }));
  },

  // Repost Actions
  addRepost: (repostData) => {
    const newRepost: Repost = {
      id: Date.now().toString(),
      date: new Date().toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric' 
      }),
      ...repostData,
    };

    set((state) => ({
      reposts: [newRepost, ...state.reposts],
      posts: state.posts.map((post) =>
        post.id === repostData.originalPostId
          ? {
              ...post,
              engagement: {
                ...post.engagement,
                reposts: post.engagement.reposts + 1,
              },
            }
          : post
      ),
    }));
  },

  deleteRepost: (id) => {
    set((state) => {
      const repostToDelete = state.reposts.find((repost) => repost.id === id);
      return {
        reposts: state.reposts.filter((repost) => repost.id !== id),
        posts: repostToDelete
          ? state.posts.map((post) =>
              post.id === repostToDelete.originalPostId
                ? {
                    ...post,
                    engagement: {
                      ...post.engagement,
                      reposts: Math.max(0, post.engagement.reposts - 1),
                    },
                  }
                : post
            )
          : state.posts,
      };
    });
  },

  getRepostsForPost: (postId) => {
    return get().reposts.filter((repost) => repost.originalPostId === postId);
  },

  likeRepost: (id) => {
    set((state) => ({
      reposts: state.reposts.map((repost) =>
        repost.id === id
          ? {
              ...repost,
              engagement: {
                ...repost.engagement,
                likes: repost.engagement.likes + 1,
              },
            }
          : repost
      ),
    }));
  },

  unlikeRepost: (id) => {
    set((state) => ({
      reposts: state.reposts.map((repost) =>
        repost.id === id
          ? {
              ...repost,
              engagement: {
                ...repost.engagement,
                likes: Math.max(0, repost.engagement.likes - 1),
              },
            }
          : repost
      ),
    }));
  },

  updateReply: (id, updates) => {
    set((state) => ({
      replies: state.replies.map((reply) =>
        reply.id === id ? { ...reply, ...updates } : reply
      ),
    }));
  },

  deleteReply: (id) => {
    set((state) => {
      const replyToDelete = state.replies.find((reply) => reply.id === id);
      return {
        replies: state.replies.filter((reply) => reply.id !== id),
        posts: replyToDelete
          ? state.posts.map((post) =>
              post.id === replyToDelete.postId
                ? {
                    ...post,
                    engagement: {
                      ...post.engagement,
                      replies: Math.max(0, post.engagement.replies - 1),
                    },
                  }
                : post
            )
          : state.posts,
      };
    });
  },

  likeReply: (id) => {
    set((state) => ({
      replies: state.replies.map((reply) =>
        reply.id === id
          ? {
              ...reply,
              engagement: {
                ...reply.engagement,
                likes: reply.engagement.likes + 1,
              },
            }
          : reply
      ),
    }));
  },

  unlikeReply: (id) => {
    set((state) => ({
      replies: state.replies.map((reply) =>
        reply.id === id
          ? {
              ...reply,
              engagement: {
                ...reply.engagement,
                likes: Math.max(0, reply.engagement.likes - 1),
              },
            }
          : reply
      ),
    }));
  },

  getRepliesForPost: (postId) => {
    return get().replies.filter((reply) => reply.postId === postId);
  },

  // API Integration Actions
  fetchFeed: async (request) => {
    set({ isLoading: true, error: null });
    try {
      const response = await feedService.getFeed(request);
      
      // Transform the response to match our store structure
      const posts: UIPost[] = [];
      const replies: Reply[] = [];
      const reposts: Repost[] = [];

      response.items.forEach(item => {
        if (item.type === 'post') {
          posts.push(item.data as UIPost);
        } else if (item.type === 'reply') {
          replies.push(item.data as Reply);
        } else if (item.type === 'repost') {
          reposts.push(item.data as Repost);
        }
      });

      set({ posts, replies, reposts, isLoading: false });
    } catch (error) {
      set({ 
        error: error instanceof Error ? error.message : 'Failed to fetch feed', 
        isLoading: false 
      });
    }
  },

  createReplyAPI: async (request) => {
    set({ isLoading: true, error: null });
    try {
      const response = await feedService.createReply(request);
      if (response.success) {
        // Add the new reply to the store
        const newReply = response.reply;
        set(state => ({
          replies: [newReply, ...state.replies],
          isLoading: false
        }));
      }
    } catch (error) {
      set({ 
        error: error instanceof Error ? error.message : 'Failed to create reply', 
        isLoading: false 
      });
    }
  },

  createRepostAPI: async (request) => {
    set({ isLoading: true, error: null });
    try {
      const response = await feedService.createRepost(request);
      if (response.success) {
        // Add the new repost to the store
        const newRepost = response.repost;
        set(state => ({
          reposts: [newRepost, ...state.reposts],
          isLoading: false
        }));
      }
    } catch (error) {
      set({ 
        error: error instanceof Error ? error.message : 'Failed to create repost', 
        isLoading: false 
      });
    }
  },

  likeItemAPI: async (request) => {
    try {
      const response = await feedService.likeItem(request);
      if (response.success) {
        // Update the like state in the store
        set(state => {
          if (request.type === 'post') {
            return {
              posts: state.posts.map(post => 
                post.id === request.postId 
                  ? { ...post, engagement: { ...post.engagement, likes: post.engagement.likes + 1 } }
                  : post
              )
            };
          } else if (request.type === 'reply') {
            return {
              replies: state.replies.map(reply => 
                reply.id === request.postId 
                  ? { ...reply, engagement: { ...reply.engagement, likes: reply.engagement.likes + 1 } }
                  : reply
              )
            };
          } else if (request.type === 'repost') {
            return {
              reposts: state.reposts.map(repost => 
                repost.id === request.postId 
                  ? { ...repost, engagement: { ...repost.engagement, likes: repost.engagement.likes + 1 } }
                  : repost
              )
            };
          }
          return state;
        });
      }
    } catch (error) {
      set({ 
        error: error instanceof Error ? error.message : 'Failed to like item', 
        isLoading: false 
      });
    }
  },

  unlikeItemAPI: async (request) => {
    try {
      const response = await feedService.unlikeItem(request);
      if (response.success) {
        // Update the like state in the store
        set(state => {
          if (request.type === 'post') {
            return {
              posts: state.posts.map(post => 
                post.id === request.postId 
                  ? { ...post, engagement: { ...post.engagement, likes: Math.max(0, post.engagement.likes - 1) } }
                  : post
              )
            };
          } else if (request.type === 'reply') {
            return {
              replies: state.replies.map(reply => 
                reply.id === request.postId 
                  ? { ...reply, engagement: { ...reply.engagement, likes: Math.max(0, reply.engagement.likes - 1) } }
                  : reply
              )
            };
          } else if (request.type === 'repost') {
            return {
              reposts: state.reposts.map(repost => 
                repost.id === request.postId 
                  ? { ...repost, engagement: { ...repost.engagement, likes: Math.max(0, repost.engagement.likes - 1) } }
                  : repost
              )
            };
          }
          return state;
        });
      }
    } catch (error) {
      set({ 
        error: error instanceof Error ? error.message : 'Failed to unlike item', 
        isLoading: false 
      });
    }
  },
})); 