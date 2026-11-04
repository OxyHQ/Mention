import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import type {
  PrivateMentionConversation,
  PrivateMentionConversationsResponse,
} from '@mention/shared-types';
import { api } from '@/utils/api';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { prewarmUsersByIds } from '@/utils/userEnrichment';

const PARTICIPANTS_STALE_TIME = 5 * 60 * 1000;

export interface UsePrivateMentionConversationsResult {
  conversations: PrivateMentionConversation[];
  /** The first page of a signed-in read is in flight. */
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** Asks for the next page unless one is already in flight or none is left. */
  loadMore: () => void;
  refetch: () => Promise<unknown>;
}

/**
 * The viewer's private-mention conversations, newest activity first, paged by
 * the server's opaque cursor.
 *
 * Gated on `canUsePrivateApi` and keyed by viewer: the endpoint answers only
 * for a participant, so one account's inbox must never be served to another.
 * The participants of every loaded conversation are warmed into the shared Oxy
 * user cache in one batched request, so a row reads them without a request of
 * its own.
 */
export function usePrivateMentionConversations(): UsePrivateMentionConversationsResult {
  const { user, canUsePrivateApi, oxyServices } = useAuth();
  const viewerId = user?.id;
  const enabled = canUsePrivateApi && Boolean(viewerId);

  const query = useInfiniteQuery({
    queryKey: viewerQueryKeys.privateMentions(viewerId),
    queryFn: async ({ pageParam }) => {
      const { data } = await api.get<PrivateMentionConversationsResponse>(
        '/posts/private-mentions',
        pageParam ? { cursor: pageParam } : undefined,
      );
      return data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.hasMore ? page.nextCursor : undefined),
    enabled,
  });

  const conversations = useMemo(
    () => (enabled ? (query.data?.pages.flatMap((page) => page.items) ?? []) : []),
    [enabled, query.data],
  );

  const participantIds = useMemo(
    () => [...new Set(conversations.flatMap((item) => item.participantIds))].sort(),
    [conversations],
  );

  useQuery({
    queryKey: viewerQueryKeys.privateMentionParticipants(viewerId, participantIds),
    queryFn: () => prewarmUsersByIds(participantIds, (ids) => oxyServices.users.getMany(ids)),
    enabled: enabled && participantIds.length > 0,
    staleTime: PARTICIPANTS_STALE_TIME,
  });

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return {
    conversations,
    isLoading: enabled && query.isLoading,
    isError: query.isError,
    isRefetching: query.isRefetching && !isFetchingNextPage,
    hasNextPage: Boolean(hasNextPage),
    isFetchingNextPage,
    loadMore,
    refetch: query.refetch,
  };
}
