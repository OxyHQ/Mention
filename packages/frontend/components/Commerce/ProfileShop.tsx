import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useCallback, useEffect, type ReactElement } from 'react';
import { VirtualList } from '@oxy.so/bloom/list';
import { useContainerWidth } from '@oxy.so/bloom/hooks';
import type { CommerceReference } from '@mention/shared-types/commerce';
import { Dimensions, Linking, Text, View } from 'react-native';
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

type ShopRow =
  | { kind: 'content'; key: string; element: ReactElement }
  | { kind: 'card'; key: string };
interface ProfileShopProps {
  accountId: string;
  listContentHeaderComponent?: ReactElement | null;
  listStickyHeaderComponent?: ReactElement | null;
}
export function ProfileShop({
  accountId,
  listContentHeaderComponent,
  listStickyHeaderComponent,
}: ProfileShopProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const store = useCommerceStorefront(accountId);
  const available = store.isSuccess && store.data.state === 'available';
  const products = useInfiniteQuery({
    queryKey: viewerQueryKeys.commerceCatalog(
      user?.id,
      accountId,
      store.data?.state === 'available' ? store.data.ref.id : null,
      'products',
    ),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => commerceService.storeProducts(accountId, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: available,
    staleTime: 30_000,
  });
  const collections = useInfiniteQuery({
    queryKey: viewerQueryKeys.commerceCatalog(
      user?.id,
      accountId,
      store.data?.state === 'available' ? store.data.ref.id : null,
      'collections',
    ),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => commerceService.storeCollections(accountId, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: available,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (available) void commerceService.recordMetric('stores', accountId, 'open').catch(() => {});
  }, [accountId, available]);
  const { width, onLayout } = useContainerWidth();
  const columns = Math.max(
    1,
    Math.min(3, Math.floor((width ?? Dimensions.get('window').width) / 240)),
  );
  const rows: ShopRow[] = [];
  if (listContentHeaderComponent)
    rows.push({ kind: 'content', key: 'profile-summary', element: listContentHeaderComponent });
  if (listStickyHeaderComponent)
    rows.push({ kind: 'content', key: 'profile-tabs', element: listStickyHeaderComponent });
  const append = (key: string, element: ReactElement) =>
    rows.push({ kind: 'content', key, element });
  const appendCards = (refs: CommerceReference[]) => {
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = commerceReferenceKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        rows.push({ kind: 'card', key });
      }
    }
  };
  if (store.isPending) append('loading', <ListSkeleton />);
  else if (!available || store.data?.state !== 'available')
    append('unavailable', <EmptyState title={t('commerce.shopUnavailable')} />);
  else {
    const currentStore = store.data.store;
    append(
      'store',
      <View className="p-4 gap-3">
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
          {t('commerce.visitStore')}
        </Button>
      </View>,
    );
    append(
      'products-heading',
      <Text accessibilityRole="header" className="px-4 py-2 text-foreground text-lg font-semibold">
        {t('commerce.products')}
      </Text>,
    );
    const productRefs =
      products.data?.pages.flatMap((page) => page.items.map((item) => item.ref)) ?? [];
    if (products.isPending) append('products-loading', <ListSkeleton />);
    else if (products.isError)
      append('products-error', <EmptyState title={t('commerce.catalogUnavailable')} />);
    else if (!productRefs.length)
      append('products-empty', <EmptyState title={t('commerce.empty')} />);
    else appendCards(productRefs);
    if (products.hasNextPage)
      append(
        'products-more',
        <Button
          disabled={products.isFetchingNextPage}
          onPress={() => void products.fetchNextPage()}
        >
          {t('commerce.more')}
        </Button>,
      );
    append(
      'collections-heading',
      <Text accessibilityRole="header" className="px-4 py-2 text-foreground text-lg font-semibold">
        {t('commerce.collections')}
      </Text>,
    );
    const collectionRefs =
      collections.data?.pages.flatMap((page) => page.items.map((item) => item.ref)) ?? [];
    if (collections.isPending) append('collections-loading', <ListSkeleton />);
    else if (collections.isError)
      append('collections-error', <EmptyState title={t('commerce.catalogUnavailable')} />);
    else if (!collectionRefs.length)
      append('collections-empty', <EmptyState title={t('commerce.empty')} />);
    else appendCards(collectionRefs);
    if (collections.hasNextPage)
      append(
        'collections-more',
        <Button
          disabled={collections.isFetchingNextPage}
          onPress={() => void collections.fetchNextPage()}
        >
          {t('commerce.more')}
        </Button>,
      );
  }
  const renderRow = useCallback(
    ({ item }: { item: ShopRow }) =>
      item.kind === 'content' ? (
        item.element
      ) : (
        <View className="p-1.5">
          <CommerceCard referenceId={item.key} />
        </View>
      ),
    [],
  );
  const span = useCallback(
    (layout: { span?: number }, item: ShopRow) => {
      if (item.kind === 'content') layout.span = columns;
    },
    [columns],
  );
  return (
    <View onLayout={onLayout} style={{ flex: 1, minHeight: 0 }} testID="commerce-shop">
      <VirtualList
        screen={{}}
        data={rows}
        keyExtractor={(item) => item.key}
        renderItem={renderRow}
        getItemType={(item) => item.kind}
        numColumns={columns}
        overrideItemLayout={span}
        stickyHeaderIndices={
          listStickyHeaderComponent ? [listContentHeaderComponent ? 1 : 0] : undefined
        }
        estimatedItemSize={272}
        overscan={2}
        maxItemsInRecyclePool={24}
        drawDistance={544}
        scrollbar="never"
      />
    </View>
  );
}
