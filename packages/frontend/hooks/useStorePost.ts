import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import type { FeedItem } from '@/db';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { usePostSelector, usePostsStore } from '@/stores/postsStore';

interface StorePostOptions {
  enabled?: boolean;
  /**
   * Read the post from the server even when it is cached, because this surface
   * acts on viewer state a feed copy may predate (a collaboration invite).
   */
  fresh?: boolean;
  staleTime?: number;
}

/**
 * One post, read from the shared posts store and loaded into it when missing.
 *
 * The store is the only post cache: React Query here only schedules the read
 * (deduplication, retries, staleness, the `posts` family's invalidation) and
 * keeps a boolean, never a second copy of the post that the store's optimistic
 * writes would not reach.
 */
export function useStorePost(
  postId: string | undefined,
  { enabled = true, fresh = false, staleTime = 60_000 }: StorePostOptions = {},
): FeedItem | null {
  const { user } = useAuth();
  const post = usePostSelector(postId);
  useQuery({
    queryKey: viewerQueryKeys.post(user?.id, postId ?? ''),
    queryFn: async () => {
      const store = usePostsStore.getState();
      const id = postId ?? '';
      return (await (fresh ? store.revalidatePostById(id) : store.getPostById(id))) !== null;
    },
    enabled: Boolean(postId) && enabled && (fresh || !post),
    staleTime,
  });
  return post;
}
