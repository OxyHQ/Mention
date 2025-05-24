import { useCallback, useEffect, useState } from 'react';
import { fetchData } from '@/utils/api';
import { Post } from '@/interfaces/Post';

export type FeedType = 'all' | 'posts' | 'replies' | 'quotes' | 'reposts' | 'media' | 'following' | 'home';

interface UseFeedOptions {
  type?: FeedType;
  parentId?: string;
  limit?: number;
}

interface FeedResponse {
  posts: Post[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function useFeed({ type = 'all', parentId, limit = 20 }: UseFeedOptions) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const endpoint = (() => {
    if (type === 'replies' && parentId) return `feed/replies/${parentId}`;
    if (type === 'media') return 'feed/media';
    if (type === 'quotes') return 'feed/quotes';
    if (type === 'reposts') return 'feed/reposts';
    if (type === 'posts') return 'feed/posts';
    if (type === 'following') return 'feed/following';
    if (type === 'home') return 'feed/home';
    if (type === 'all') return 'feed/explore';
    return 'feed/explore';
  })();

  const fetchFeed = useCallback(async (reset = false) => {
    setLoading(true);
    setError(null);
    try {
      const params: any = { limit };
      if (!reset && nextCursor) params.cursor = nextCursor;
      const res = await fetchData<{
        data: FeedResponse;
      }>(endpoint, { params });
      const { posts: newPosts, nextCursor: newCursor, hasMore: more } = res.data;
      setPosts(prev => reset ? newPosts : [...prev, ...newPosts]);
      setNextCursor(newCursor);
      setHasMore(more);
    } catch (e: any) {
      setError(e.message || 'Failed to load feed');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [endpoint, limit, nextCursor]);

  useEffect(() => {
    fetchFeed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, parentId]);

  const refresh = () => {
    setRefreshing(true);
    setNextCursor(null);
    fetchFeed(true);
  };

  const fetchMore = () => {
    if (!loading && hasMore) {
      fetchFeed();
    }
  };

  return {
    posts,
    loading,
    refreshing,
    error,
    hasMore,
    fetchMore,
    refresh,
  };
}
