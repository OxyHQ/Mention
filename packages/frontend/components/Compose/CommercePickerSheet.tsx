import { publicQueryKeys, viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useAuth } from '@oxy.so/services/ui/client';
import { useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search } from '@oxy.so/bloom/search';
import { Item } from '@oxy.so/bloom/item';
import { Button } from '@oxy.so/bloom/button';
import { MAX_COMMERCE_ATTACHMENTS, type CommerceReference } from '@mention/shared-types/commerce';
import { commerceReferenceKey } from '@/utils/commerceReferences';
import { commerceService } from '@/services/commerceService';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';

export default function CommercePickerSheet({
  accountId,
  selected,
  onSelect,
  onClose,
}: {
  accountId?: string;
  selected: readonly CommerceReference[];
  onSelect: (ref: CommerceReference) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [mode, setMode] = useState<'products' | 'collections'>('products');
  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const products = useInfiniteQuery({
    queryKey: publicQueryKeys.commerceProducts(term),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      commerceService.products({ query: term || undefined, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: mode === 'products',
    staleTime: 30_000,
  });
  const collections = useInfiniteQuery({
    queryKey: viewerQueryKeys.commerceCatalog(user?.id, accountId, null, 'collections'),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => commerceService.storeCollections(accountId ?? '', pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: mode === 'collections' && Boolean(accountId),
    staleTime: 30_000,
  });
  const current = mode === 'products' ? products : collections;
  const rows: { ref: CommerceReference; title: string }[] =
    mode === 'products'
      ? (products.data?.pages.flatMap((page) => page.items) ?? [])
      : (collections.data?.pages.flatMap((page) => page.items) ?? []);
  const selectedKeys = new Set(selected.map(commerceReferenceKey));
  return (
    <View className="bg-background px-4 pt-3 pb-2 gap-3">
      <Text className="text-foreground text-lg font-bold">
        {t('commerce.attach', { defaultValue: 'Add products or collections' })}
      </Text>
      <Text className="text-muted-foreground">
        {t('commerce.limit', {
          defaultValue: '{{count}} of {{max}} attached',
          count: selected.length,
          max: MAX_COMMERCE_ATTACHMENTS,
        })}
      </Text>
      <View className="flex-row gap-2">
        <Button onPress={() => setMode('products')}>
          {t('commerce.products', { defaultValue: 'Products' })}
        </Button>
        {accountId ? (
          <Button onPress={() => setMode('collections')}>
            {t('commerce.collections', { defaultValue: 'Your store collections' })}
          </Button>
        ) : null}
      </View>
      {mode === 'products' ? (
        <Search
          label={t('commerce.search', { defaultValue: 'Search Mercaria products' })}
          value={query}
          onChangeText={setQuery}
          onClearText={() => setQuery('')}
        />
      ) : null}
      {current.isLoading ? (
        <ListSkeleton />
      ) : current.isError ? (
        <Text className="text-muted-foreground">
          {t('commerce.catalogUnavailable', {
            defaultValue: 'No connected store or catalog unavailable. Try again shortly.',
          })}
        </Text>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => commerceReferenceKey(item.ref)}
          className="max-h-[340px]"
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Item
              title={item.title}
              disabled={
                selectedKeys.has(commerceReferenceKey(item.ref)) ||
                selected.length >= MAX_COMMERCE_ATTACHMENTS
              }
              onPress={() => {
                onSelect(item.ref);
                onClose();
              }}
            />
          )}
          onEndReached={() => {
            if (current.hasNextPage && !current.isFetchingNextPage) void current.fetchNextPage();
          }}
          ListEmptyComponent={
            <Text className="text-muted-foreground p-4">
              {t('commerce.empty', { defaultValue: 'No items found' })}
            </Text>
          }
        />
      )}
    </View>
  );
}
