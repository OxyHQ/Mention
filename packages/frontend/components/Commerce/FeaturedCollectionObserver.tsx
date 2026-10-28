import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import type { MercariaPage, MercariaProductSummary } from '@mercaria.co/sdk';
import { useScreenVisible } from '@oxy.so/bloom/screen';
import { viewerQueryKeys, type ViewerId } from '@/lib/viewerQueryKeys';
import { commerceService } from '@/services/commerceService';

export interface FeaturedCollectionSnapshot {
  data: InfiniteData<MercariaPage<MercariaProductSummary>> | undefined;
  error: unknown;
  isPending: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
}

/** Observe independent infinite pages without adding a second scroll/list owner. */
export function FeaturedCollectionObserver({
  viewerId,
  accountId,
  storeId,
  collectionId,
  onChange,
}: {
  viewerId: ViewerId;
  accountId: string;
  storeId: string;
  collectionId: string;
  onChange: (identity: string, state: FeaturedCollectionSnapshot | undefined) => void;
}) {
  const visible = useScreenVisible();
  const queryKey = viewerQueryKeys.commerceFeaturedProducts(
    viewerId,
    accountId,
    storeId,
    collectionId,
  );
  const identity = JSON.stringify(queryKey);
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      commerceService.featuredCollectionProducts(accountId, collectionId, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: visible,
    staleTime: 30_000,
    refetchInterval: visible ? 30_000 : false,
    retry: false,
  });
  const { data, error, isPending, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const snapshot = useMemo(
    () => ({ data, error, isPending, isError, hasNextPage, isFetchingNextPage, fetchNextPage }),
    [data, error, isPending, isError, hasNextPage, isFetchingNextPage, fetchNextPage],
  );
  useEffect(() => {
    onChange(identity, snapshot);
  }, [identity, snapshot, onChange]);
  useEffect(() => () => onChange(identity, undefined), [identity, onChange]);
  return null;
}
