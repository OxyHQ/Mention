import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
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

async function searchPodcasts(query: string): Promise<PodcastSearchResult[]> {
  const res = await api.get<{ data: PodcastSearchResult[] }>('profile/media/search', {
    type: 'podcast',
    q: query,
  });
  return Array.isArray(res.data?.data) ? res.data.data : [];
}

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

  const search = useQuery({
    queryKey: ['compose-podcast-search', debouncedQuery],
    queryFn: () => searchPodcasts(debouncedQuery),
    enabled: debouncedQuery.length > 0,
    staleTime: 60_000,
  });

  const results = useMemo(() => search.data ?? [], [search.data]);

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
          <ScrollView className="max-h-[340px]" showsVerticalScrollIndicator={false}>
            {results.map((result) => (
              <PodcastResultRow key={result.syraPodcastId} result={result} onSelect={handleSelect} />
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
});

export default PodcastPickerSheet;
