import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Item } from '@oxyhq/bloom/item';
import { useTheme } from '@oxyhq/bloom/theme';
import {
  MagnifyingGlass_Stroke2_Corner0_Rounded,
  MagnifyingGlassX_Stroke2_Corner0_Rounded,
  CircleX_Stroke2_Corner0_Rounded,
  SpeakerVolumeFull_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';
import { api } from '@/utils/api';
import type { PodcastAttachmentData } from '@/hooks/usePodcastManager';

const SEARCH_DEBOUNCE_MS = 350;

interface PodcastSearchResult {
  syraPodcastId: string;
  title: string;
  author?: string;
  artworkUrl?: string;
}

interface PodcastPickerSheetProps {
  onSelect: (podcast: PodcastAttachmentData) => void;
  onClose: () => void;
}

/**
 * One page of podcast search rows plus the offset to request next. The proxy
 * returns a `{ data, pagination }` envelope which `@oxyhq/core`'s HttpService
 * leaves un-unwrapped (the `pagination` key suppresses the `{ data }` unwrap),
 * so rows live at `res.data.data` and page metadata at `res.data.pagination`.
 * `nextOffset` advances by the page size (`limit`), never by `rows.length`.
 */
interface PodcastSearchPage {
  rows: PodcastSearchResult[];
  hasMore: boolean;
  nextOffset: number;
}

interface PaginatedSearchEnvelope {
  data: PodcastSearchResult[];
  pagination: { hasMore: boolean; offset: number; limit: number };
}

async function fetchPodcastPage(query: string, offset: number): Promise<PodcastSearchPage> {
  const res = await api.get<PaginatedSearchEnvelope>('profile/media/search', {
    type: 'podcast',
    q: query,
    offset,
  });
  const rows = res.data?.data ?? [];
  const pagination = res.data?.pagination;
  return {
    rows,
    hasMore: pagination?.hasMore ?? false,
    nextOffset: (pagination?.offset ?? 0) + (pagination?.limit ?? rows.length),
  };
}

/** Spinner shown at the bottom of the results list while the next page loads. */
const ResultsFooter = memo(function ResultsFooter({ loading }: { loading: boolean }) {
  const { colors } = useTheme();
  if (!loading) {
    return null;
  }
  return (
    <View className="items-center justify-center py-3">
      <ActivityIndicator size="small" color={colors.primary} />
    </View>
  );
});

/** A single podcast search result row. Selecting it attaches the show. */
const PodcastResultRow = memo(function PodcastResultRow({
  result,
  onSelect,
}: {
  result: PodcastSearchResult;
  onSelect: (result: PodcastSearchResult) => void;
}) {
  const { colors } = useTheme();

  const handlePress = useCallback(() => {
    onSelect(result);
  }, [onSelect, result]);

  return (
    <Item
      onPress={handlePress}
      title={result.title}
      subtitle={result.author}
      leading={
        result.artworkUrl ? (
          <Image
            source={{ uri: result.artworkUrl }}
            style={{ width: 40, height: 40, borderRadius: 6 }}
            contentFit="cover"
            transition={120}
          />
        ) : (
          <View
            className="rounded-md bg-secondary items-center justify-center"
            style={{ width: 40, height: 40 }}
          >
            <SpeakerVolumeFull_Stroke2_Corner0_Rounded size="md" fill={colors.textSecondary} />
          </View>
        )
      }
    />
  );
});

/**
 * Compose podcast picker: a debounced search over the Syra catalog proxy
 * (`profile/media/search?type=podcast`) that attaches the chosen show to the
 * draft. No preview, no profile-store coupling — selecting a row reports the show
 * via `onSelect` and closes. Mirrors the podcast flow of `MediaPickerSheet`.
 */
const PodcastPickerSheet = memo(function PodcastPickerSheet({
  onSelect,
  onClose,
}: PodcastPickerSheetProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Debounce the raw input into the query key (React Query owns the fetch,
  // dedupe, and caching).
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const search = useInfiniteQuery({
    queryKey: ['compose-podcast-search', debouncedQuery],
    queryFn: ({ pageParam }) => fetchPodcastPage(debouncedQuery, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset : undefined),
    enabled: debouncedQuery.length > 0,
    staleTime: 60_000,
  });

  const results = useMemo(
    () => search.data?.pages.flatMap((page) => page.rows) ?? [],
    [search.data],
  );

  const loadMore = useCallback(() => {
    if (search.hasNextPage && !search.isFetchingNextPage) {
      void search.fetchNextPage();
    }
  }, [search.hasNextPage, search.isFetchingNextPage, search.fetchNextPage]);

  const handleSelect = useCallback(
    (result: PodcastSearchResult) => {
      onSelect({
        syraPodcastId: result.syraPodcastId,
        title: result.title,
        author: result.author,
        artworkUrl: result.artworkUrl,
      });
      onClose();
    },
    [onSelect, onClose],
  );

  return (
    <View className="bg-background px-4 pt-3 pb-2">
      <Text className="text-foreground text-lg font-bold mb-3">
        {t('compose.podcast.title')}
      </Text>

      {/* Search input — mirrors MediaPickerSheet's styled search row. */}
      <View className="flex-row items-center px-3 py-2.5 rounded-xl bg-secondary gap-2.5">
        <MagnifyingGlass_Stroke2_Corner0_Rounded size="sm" fill={colors.textSecondary} />
        <TextInput
          className="flex-1 text-[15px] text-foreground"
          placeholder={t('compose.podcast.searchPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query.length > 0 && (
          <Pressable
            onPress={() => setQuery('')}
            accessibilityRole="button"
            accessibilityLabel={t('profile.media.clearSearch')}
            hitSlop={8}
          >
            <CircleX_Stroke2_Corner0_Rounded size="sm" fill={colors.textSecondary} />
          </Pressable>
        )}
      </View>

      {/* Results */}
      <View className="mt-2 min-h-[120px]">
        {search.isLoading ? (
          <View className="items-center justify-center py-10">
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        ) : search.isError ? (
          <Text className="text-muted-foreground text-[15px] text-center py-10">
            {t('compose.podcast.searchError')}
          </Text>
        ) : debouncedQuery.length === 0 ? (
          <Text className="text-muted-foreground text-[15px] text-center py-10">
            {t('compose.podcast.searchHint')}
          </Text>
        ) : results.length === 0 ? (
          <View className="items-center justify-center py-10 gap-2">
            <MagnifyingGlassX_Stroke2_Corner0_Rounded size="xl" fill={colors.textSecondary} />
            <Text className="text-muted-foreground text-[15px]">
              {t('compose.podcast.empty')}
            </Text>
          </View>
        ) : (
          <FlatList
            data={results}
            keyExtractor={(item) => item.syraPodcastId}
            renderItem={({ item }) => <PodcastResultRow result={item} onSelect={handleSelect} />}
            className="max-h-[340px]"
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onEndReached={loadMore}
            onEndReachedThreshold={0.4}
            ListFooterComponent={<ResultsFooter loading={search.isFetchingNextPage} />}
          />
        )}
      </View>
    </View>
  );
});

export default PodcastPickerSheet;
