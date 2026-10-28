import { useEffect } from 'react';
import { Linking, Text, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { useAuth } from '@oxy.so/services/ui/client';
import { commerceService } from '@/services/commerceService';
import { useCommerceStorefront } from '@/hooks/useCommerceStorefront';
import { commerceReferenceKey } from '@/utils/commerceReferences';
import { CommerceCard } from '@/components/Post/Attachments/CommerceCard';
import { EmptyState } from '@/components/common/EmptyState';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';

export function ProfileShop({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const store = useCommerceStorefront(accountId);
  const available = store.isSuccess && store.data.state === 'available';
  const products = useInfiniteQuery({
    queryKey: [
      'commerce-store-products',
      user?.id ?? null,
      accountId,
      store.data?.state === 'available' ? store.data.ref.id : null,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => commerceService.storeProducts(accountId, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: available,
    staleTime: 30_000,
  });
  const collections = useInfiniteQuery({
    queryKey: [
      'commerce-store-collections',
      user?.id ?? null,
      accountId,
      store.data?.state === 'available' ? store.data.ref.id : null,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => commerceService.storeCollections(accountId, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: available,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (available) void commerceService.recordMetric('stores', accountId, 'open').catch(() => {});
  }, [accountId, available]);
  if (store.isPending) return <ListSkeleton />;
  if (!available || store.data?.state !== 'available')
    return (
      <EmptyState
        title={t('commerce.shopUnavailable', { defaultValue: 'This shop is unavailable' })}
      />
    );
  const currentStore = store.data.store;
  const productRows = products.data?.pages.flatMap((page) => page.items) ?? [];
  const collectionRows = collections.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <View className="p-4 gap-4">
      <Text className="text-foreground text-xl font-bold">{currentStore.name}</Text>
      {currentStore.description ? (
        <Text className="text-muted-foreground">{currentStore.description}</Text>
      ) : null}
      <Button
        onPress={() => {
          void commerceService.recordMetric('stores', accountId, 'handoff').catch(() => {});
          void Linking.openURL(currentStore.url);
        }}
      >
        {t('commerce.visitStore', { defaultValue: 'Visit store on Mercaria' })}
      </Button>
      <Text className="text-foreground text-lg font-semibold">
        {t('commerce.products', { defaultValue: 'Products' })}
      </Text>
      {products.isPending ? (
        <ListSkeleton />
      ) : products.isError ? (
        <EmptyState
          title={t('commerce.catalogUnavailable', { defaultValue: 'Catalog unavailable' })}
        />
      ) : productRows.length === 0 ? (
        <EmptyState title={t('commerce.empty')} />
      ) : (
        <View className="flex-row flex-wrap gap-3">
          {productRows.map((item) => (
            <CommerceCard
              key={commerceReferenceKey(item.ref)}
              referenceId={commerceReferenceKey(item.ref)}
              className="w-[260px] flex-grow"
            />
          ))}
        </View>
      )}
      {products.hasNextPage ? (
        <Button
          disabled={products.isFetchingNextPage}
          onPress={() => void products.fetchNextPage()}
        >
          {t('commerce.more', { defaultValue: 'Load more' })}
        </Button>
      ) : null}
      <Text className="text-foreground text-lg font-semibold">
        {t('commerce.collections', { defaultValue: 'Collections' })}
      </Text>
      {collections.isPending ? (
        <ListSkeleton />
      ) : collections.isError ? (
        <EmptyState title={t('commerce.catalogUnavailable')} />
      ) : collectionRows.length === 0 ? (
        <EmptyState title={t('commerce.empty')} />
      ) : (
        <View className="flex-row flex-wrap gap-3">
          {collectionRows.map((item) => (
            <CommerceCard
              key={commerceReferenceKey(item.ref)}
              referenceId={commerceReferenceKey(item.ref)}
              className="w-[260px] flex-grow"
            />
          ))}
        </View>
      )}
      {collections.hasNextPage ? (
        <Button
          disabled={collections.isFetchingNextPage}
          onPress={() => void collections.fetchNextPage()}
        >
          {t('commerce.more', { defaultValue: 'Load more' })}
        </Button>
      ) : null}
    </View>
  );
}
