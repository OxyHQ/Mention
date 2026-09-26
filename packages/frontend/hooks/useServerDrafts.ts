import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import type { HydratedPost } from '@mention/shared-types';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { draftsService } from '@/services/draftsService';

const SERVER_DRAFTS_STALE_TIME = 30_000;

export interface UseServerDraftsResult {
  /**
   * The drafts stored on the server for this viewer, newest first (the server's
   * order) — their own, plus those of each channel they operate.
   */
  serverDrafts: HydratedPost[];
  /** True only while the first authenticated fetch is in flight. */
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  /** Publish one draft now. Rejects when the server refuses. */
  publishServerDraft: (postId: string) => Promise<void>;
  /** Delete one draft; it is never published. Rejects when the server refuses. */
  deleteServerDraft: (postId: string) => Promise<void>;
  /**
   * The signed-in reader, so a row can say which account a draft belongs to.
   * Returned for the same reason `useScheduledPosts` returns it.
   */
  viewerId?: string;
}

/** What an optimistic removal took off the list, so a refusal can put it back. */
interface RemovalContext {
  previous: HydratedPost[] | undefined;
}

/**
 * The viewer's SERVER drafts: posts stored with `status: 'draft'`, today mostly
 * written by an automation through the API or MCP, waiting for a person.
 *
 * This is the cache the drafts screen reads, on ONE viewer-scoped key
 * (`viewerQueryKeys.serverDrafts`), with every request going through
 * `draftsService`. That is deliberate groundwork: drafts are moving to the
 * server entirely, and this query is meant to become their single source of
 * truth, with the composer writing into the same key.
 *
 * Publishing and deleting are OPTIMISTIC. The row leaves the cache as the
 * request starts, comes back if the server refuses, and the list is revalidated
 * either way, so what is on screen converges on what the server holds. Gated on
 * `canUsePrivateApi` and keyed on the viewer, for the reasons `useScheduledPosts`
 * gives.
 */
export function useServerDrafts(): UseServerDraftsResult {
  const { user, isAuthenticated, canUsePrivateApi } = useAuth();
  const viewerId = user?.id;
  const queryClient = useQueryClient();
  const queryKey = viewerQueryKeys.serverDrafts(viewerId);

  const enabled = isAuthenticated && Boolean(viewerId) && canUsePrivateApi;

  const query = useQuery<HydratedPost[]>({
    queryKey,
    queryFn: () => draftsService.list(),
    enabled,
    staleTime: SERVER_DRAFTS_STALE_TIME,
  });

  // Published or deleted, a draft leaves this list either way, so both
  // mutations share one optimistic removal.
  const removeOptimistically = useCallback(async (postId: string): Promise<RemovalContext> => {
    // A read already in flight would land after the removal and put the row
    // straight back.
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData<HydratedPost[]>(queryKey);
    queryClient.setQueryData<HydratedPost[]>(queryKey, (current) =>
      current?.filter((post) => post.id !== postId),
    );
    return { previous };
  }, [queryClient, queryKey]);

  const restore = useCallback((context: RemovalContext | undefined) => {
    if (context?.previous) {
      queryClient.setQueryData<HydratedPost[]>(queryKey, context.previous);
    }
  }, [queryClient, queryKey]);

  const revalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const publishMutation = useMutation<void, unknown, string, RemovalContext>({
    mutationFn: (postId: string) => draftsService.publish(postId),
    onMutate: removeOptimistically,
    onError: (_error, _postId, context) => restore(context),
    onSettled: revalidate,
  });

  const deleteMutation = useMutation<void, unknown, string, RemovalContext>({
    mutationFn: (postId: string) => draftsService.remove(postId),
    onMutate: removeOptimistically,
    onError: (_error, _postId, context) => restore(context),
    onSettled: revalidate,
  });

  const { mutateAsync: publish } = publishMutation;
  const publishServerDraft = useCallback(async (postId: string) => {
    await publish(postId);
  }, [publish]);

  const { mutateAsync: remove } = deleteMutation;
  const deleteServerDraft = useCallback(async (postId: string) => {
    await remove(postId);
  }, [remove]);

  return {
    serverDrafts: enabled ? query.data ?? [] : [],
    isLoading: enabled && query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    publishServerDraft,
    deleteServerDraft,
    viewerId,
  };
}
