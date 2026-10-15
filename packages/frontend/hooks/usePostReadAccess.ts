import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { usePostsStore } from '@/stores/postsStore';
import { useSupervisionState } from './useSupervisionState';

/** Opening a supervised detail requires a current authorized response, even on a warm cache. */
export function usePostReadAccess(postId: string) {
  const { user } = useAuth();
  const supervision = useSupervisionState();
  const read = useQuery({
    queryKey: viewerQueryKeys.postAccess(user?.id, postId),
    enabled: Boolean(postId) && supervision.ready && supervision.supervised,
    queryFn: async () => {
      const post = await usePostsStore.getState().revalidatePostById(postId);
      if (!post) throw new Error('Post access is unavailable');
      return true;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  return {
    allowed: supervision.ready && (!supervision.supervised || (read.isSuccess && !read.isFetching)),
    supervised: supervision.supervised,
    failed: supervision.isError || (supervision.supervised && read.isError),
    retry: async () => {
      if (supervision.isError) await supervision.refetch();
      else await read.refetch();
    },
  };
}
