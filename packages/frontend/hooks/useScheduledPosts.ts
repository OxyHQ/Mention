import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services/ui/client';
import type { HydratedPost } from '@mention/shared-types';
import { api } from '@/utils/api';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

const SCHEDULED_STALE_TIME = 30_000;

/**
 * `GET /posts/scheduled` serves the same hydrated DTO every other post listing
 * serves, so a scheduled post can be PREVIEWED through the feed's own renderer
 * rather than a client-side approximation that drifts from it. The server
 * enforces the ACL twice: the query is scoped to the caller's `oxyUserId`, and
 * `PostHydrationService` drops any non-`published` post for a viewer who does
 * not own it.
 */
interface ScheduledPostsResponse {
  posts?: HydratedPost[];
}

export interface UseScheduledPostsResult {
  /** The viewer's pending scheduled posts, soonest first (the server's order). */
  scheduledPosts: HydratedPost[];
  /** True only while the first authenticated fetch is in flight. */
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  /** Cancel one scheduled post — it is deleted, never published. */
  cancelScheduledPost: (postId: string) => Promise<void>;
  /** Publish one scheduled post immediately, ahead of its time. */
  publishScheduledPostNow: (postId: string) => Promise<void>;
}

/**
 * The viewer's scheduled posts, plus the cancel command.
 *
 * Cancelling reuses `DELETE /posts/:id`, which already owner-scopes its query
 * (`{ _id, oxyUserId }`) and is status-agnostic — a scheduled post is simply
 * removed before `ScheduledPostPublisher` ever reaches it. Nothing federates,
 * because that path only broadcasts for `status: 'published'` posts.
 *
 * The read is gated on `canUsePrivateApi` (never bare `isAuthenticated`) so no
 * request fires before a usable bearer exists, and the key is viewer-scoped so
 * an account switch can never serve A's queue to B.
 */
export function useScheduledPosts(): UseScheduledPostsResult {
  const { user, isAuthenticated, canUsePrivateApi } = useAuth();
  const viewerId = user?.id;
  const queryClient = useQueryClient();
  const queryKey = viewerQueryKeys.scheduledPosts(viewerId);

  const enabled = isAuthenticated && Boolean(viewerId) && canUsePrivateApi;

  const query = useQuery<HydratedPost[]>({
    queryKey,
    queryFn: async () => {
      const { data } = await api.get<ScheduledPostsResponse>('/posts/scheduled');
      return Array.isArray(data?.posts) ? data.posts : [];
    },
    enabled,
    staleTime: SCHEDULED_STALE_TIME,
  });

  const cancelMutation = useMutation<void, unknown, string>({
    mutationFn: async (postId: string) => {
      await api.delete(`/posts/${postId}`);
    },
    onSuccess: (_result, postId) => {
      queryClient.setQueryData<HydratedPost[]>(queryKey, (previous) =>
        previous?.filter((post) => post.id !== postId),
      );
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const publishMutation = useMutation<void, unknown, string>({
    mutationFn: async (postId: string) => {
      await api.post(`/posts/${postId}/publish`);
    },
    onSuccess: (_result, postId) => {
      // It left the queue by publishing rather than by deletion, but the queue
      // is "posts still waiting", so the row goes either way.
      queryClient.setQueryData<HydratedPost[]>(queryKey, (previous) =>
        previous?.filter((post) => post.id !== postId),
      );
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const { mutateAsync: cancel } = cancelMutation;
  const cancelScheduledPost = useCallback(async (postId: string) => {
    await cancel(postId);
  }, [cancel]);

  const { mutateAsync: publishNow } = publishMutation;
  const publishScheduledPostNow = useCallback(async (postId: string) => {
    await publishNow(postId);
  }, [publishNow]);

  return {
    scheduledPosts: enabled ? query.data ?? [] : [],
    isLoading: enabled && query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    cancelScheduledPost,
    publishScheduledPostNow,
  };
}
