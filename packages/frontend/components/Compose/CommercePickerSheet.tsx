import { publicQueryKeys, viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useAuth } from '@oxy.so/services/ui/client';
import { useEffect, useState } from 'react';
import { FlatList } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { nextUnvisitedCursor } from '@oxy.so/utils/paging';
import { useTranslation } from 'react-i18next';
import { MAX_COMMERCE_ATTACHMENTS, type CommerceReference } from '@mention/shared-types/commerce';
import { commerceReferenceKey } from '@/utils/commerceReferences';
import { commerceService } from '@/services/commerceService';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';

import {
  Button as LButton,
  Embed,
  HStack,
  RawText,
  Row,
  Search as LSearch,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

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
    getNextPageParam: (page, _pages, _pageParam, pageParams) =>
      nextUnvisitedCursor(page.nextCursor, pageParams),
    enabled: mode === 'products',
    staleTime: 30_000,
  });
  const collections = useInfiniteQuery({
    queryKey: viewerQueryKeys.commerceCatalog(user?.id, accountId, null, 'collections'),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => commerceService.storeCollections(accountId ?? '', pageParam),
    getNextPageParam: (page, _pages, _pageParam, pageParams) =>
      nextUnvisitedCursor(page.nextCursor, pageParams),
    enabled: mode === 'collections' && Boolean(accountId),
    staleTime: 30_000,
  });
  const current = mode === 'products' ? products : collections;
  const rows: { ref: CommerceReference; title: string }[] =
    mode === 'products'
      ? (products.data?.pages.flatMap((page) => page.items) ?? [])
      : (collections.data?.pages.flatMap((page) => page.items) ?? []);
  const selectedKeys = new Set(selected.map(commerceReferenceKey));
  return toElement(
    VStack(
      RawText(t('commerce.attach', { defaultValue: 'Add products or collections' }))
        .foreground('foreground')
        .font('18')
        .leading('28px')
        .weight('bold'),
      RawText(
        t('commerce.limit', {
          defaultValue: '{{count}} of {{max}} attached',
          count: selected.length,
          max: MAX_COMMERCE_ATTACHMENTS,
        }),
      ).foreground('muted'),
      HStack(
        LButton(LText(t('commerce.products', { defaultValue: 'Products' }))).onPress(() =>
          setMode('products'),
        ),
        accountId
          ? LButton(
              LText(t('commerce.collections', { defaultValue: 'Your store collections' })),
            ).onPress(() => setMode('collections'))
          : null,
      ).spacing('sm'),
      mode === 'products'
        ? LSearch([query, setQuery])
            .label(t('commerce.search', { defaultValue: 'Search Mercaria products' }))
            .onClearText(() => setQuery(''))
        : null,
      Embed(
        current.isLoading ? (
          <ListSkeleton />
        ) : current.isError ? (
          toElement(
            RawText(
              t('commerce.catalogUnavailable', {
                defaultValue: 'No connected store or catalog unavailable. Try again shortly.',
              }),
            ).foreground('muted'),
          )
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(item) => commerceReferenceKey(item.ref)}
            className="max-h-[340px]"
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) =>
              toElement(
                Row(item.title)
                  .disabled(
                    selectedKeys.has(commerceReferenceKey(item.ref)) ||
                      selected.length >= MAX_COMMERCE_ATTACHMENTS,
                  )
                  .onPress(() => {
                    onSelect(item.ref);
                    onClose();
                  }),
              )
            }
            onEndReached={() => {
              if (current.hasNextPage && !current.isFetchingNextPage) void current.fetchNextPage();
            }}
            ListEmptyComponent={toElement(
              RawText(t('commerce.empty', { defaultValue: 'No items found' }))
                .padding('all', 'lg')
                .foreground('muted'),
            )}
          />
        ),
      ),
    )
      .padding('horizontal', 'lg')
      .padding('top', 'md')
      .padding('bottom', 'sm')
      .background('background')
      .spacing('md'),
  );
}
