import { useCallback, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services/ui/client';
import type { ChannelWriter } from '@mention/shared-types';
import { channelWritersService } from '@/services/channelWritersService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

export interface ChannelWritersState {
  /** The people this channel has named, most recent publication first. */
  writers: ChannelWriter[];
  /**
   * Whether this channel NAMES the people who write for it — the whole tab-
   * visibility rule.
   *
   * It is the QUERY'S OWN SUCCESS, not anything in the body, because the server
   * refuses with a 404 in every case where there is no list to show: the account
   * is not a channel, the channel does not sign its posts, or this reader may
   * not see it. One shape for all three, so nothing here has to re-derive a
   * disclosure decision the server already made — and so a case added to that
   * refusal later needs no change on this side.
   *
   * A DISCLOSING channel that has published nothing signed answers 200 with an
   * empty list, which is a different fact and keeps the tab. Collapsing the two
   * would either hide a real (if empty) masthead or advertise one that was never
   * disclosed, so {@link writers}`.length` must never be read as this.
   */
  disclosed: boolean;
  /** True until the first page has settled either way. */
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

/**
 * A channel's writers, as both consumers need them.
 *
 * TWO callers on purpose, sharing ONE React Query key: the channel screen asks
 * only whether the tab exists, and the tab itself asks for the rows. React Query
 * serves both from a single cache entry, so the strip and its contents can never
 * disagree about whether this channel discloses — and opening the tab costs no
 * second request.
 *
 * That the screen pays for a request it may never show is not an oversight. The
 * disclosure is not on the profile DTO (it is a Mention-owned setting on the
 * channel account, and the endpoint deliberately reports it only by refusing),
 * so there is nothing cheaper to ask. The request is one index-covered
 * aggregation, and its answer is cached for the visit.
 */
export function useChannelWriters(channelOxyUserId: string | undefined): ChannelWritersState {
  const { user } = useAuth();

  const query = useInfiniteQuery({
    queryKey: viewerQueryKeys.channelWriters(user?.id, channelOxyUserId),
    queryFn: ({ pageParam }) => channelWritersService.list(channelOxyUserId ?? '', pageParam),
    initialPageParam: undefined as string | undefined,
    // The absence of `nextCursor` is the end of the list.
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: Boolean(channelOxyUserId),
    // A failure here is an ANSWER — "no writers list" — not something to recover
    // from, so retrying it spends three requests per page view to arrive back at
    // the same missing tab. The client-wide policy retries a 5xx twice, which is
    // right for a query whose failure is an error; for this one, a transient
    // outage simply means no tab for the visit, which is the fail-closed
    // direction a disclosure surface should fail in anyway.
    retry: false,
  });

  const writers = useMemo(
    () => query.data?.pages.flatMap((page) => page.writers) ?? [],
    [query.data],
  );

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  const loadMore = useCallback(() => {
    if (isFetchingNextPage || !hasNextPage) return;
    void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return {
    writers,
    disclosed: query.isSuccess,
    loading: query.isPending,
    hasMore: Boolean(hasNextPage),
    loadingMore: isFetchingNextPage,
    loadMore,
  };
}
