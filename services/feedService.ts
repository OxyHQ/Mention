import { fetchData } from '@/utils/api';
import { Post } from '@/interfaces/Post';

export type FeedType = 'home' | 'profile' | 'explore' | 'hashtag' | 'bookmarks' | 'replies';

interface FeedParams {
  userId?: string;
  hashtag?: string;
  parentId?: string;
  limit?: number;
  cursor?: string;
}

interface FeedResponse {
  posts: Post[];
  nextCursor: string | null;
  hasMore: boolean;
}

class FeedService {
  private static instance: FeedService;
  private readonly DEFAULT_LIMIT = 20;

  private constructor() {}

  public static getInstance(): FeedService {
    if (!FeedService.instance) {
      FeedService.instance = new FeedService();
    }
    return FeedService.instance;
  }

  async fetchFeed(type: FeedType, params: FeedParams = {}): Promise<FeedResponse> {
    const { userId, hashtag, parentId, limit = this.DEFAULT_LIMIT, cursor } = params;
    let endpoint = '';
    const queryParams: any = { limit, cursor };

    switch (type) {
      case 'home':
        endpoint = 'feed/home';
        break;
      case 'profile':
        if (!userId) throw new Error('userId is required for profile feed');
        endpoint = `feed/user/${userId}`;
        break;
      case 'explore':
        endpoint = 'feed/explore';
        break;
      case 'hashtag':
        if (!hashtag) throw new Error('hashtag is required for hashtag feed');
        endpoint = `feed/hashtag/${encodeURIComponent(hashtag)}`;
        break;
      case 'bookmarks':
        endpoint = 'feed/bookmarks';
        break;
      case 'replies':
        if (!parentId) throw new Error('parentId is required for replies feed');
        endpoint = `feed/replies/${parentId}`;
        break;
      default:
        throw new Error(`Unsupported feed type: ${type}`);
    }

    try {
      const response = await fetchData<{ data: FeedResponse }>(endpoint, {
        params: queryParams,
        skipCache: type === 'replies' || type === 'bookmarks', // Don't cache replies or bookmarks as they change frequently
        cacheTTL: 300000, // 5 minutes cache for other feeds
      });

      return {
        posts: response.data.posts || [],
        nextCursor: response.data.nextCursor || null,
        hasMore: response.data.hasMore || false,
      };
    } catch (error) {
      console.error(`Error fetching ${type} feed:`, error);
      throw error;
    }
  }
}

export const feedService = FeedService.getInstance(); 