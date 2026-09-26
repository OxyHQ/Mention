import React, { memo, useCallback, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { RiMic2Line } from '@oxy.so/bloom/icons/RiMic2Line';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { Search } from '@oxy.so/bloom/search';
import { useTheme } from '@oxy.so/bloom/theme';
import { useInfiniteCatalogSearch, ResultsFooter } from '@/hooks/useInfiniteCatalogSearch';
import type { PodcastAttachmentData } from '@/hooks/usePodcastManager';

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
            className="rounded-md bg-muted items-center justify-center"
            style={{ width: 40, height: 40 }}
          >
            <RiMic2Line size="md" fill={colors.textSecondary} />
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

  const search = useInfiniteCatalogSearch<PodcastSearchResult>('podcast', query);

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

      <Search
        label={t('compose.podcast.searchPlaceholder')}
        value={query}
        onChangeText={setQuery}
        onClearText={() => setQuery('')}
        autoCapitalize="none"
        autoCorrect={false}
      />

      {/* Results */}
      <View className="mt-2 min-h-[120px]">
        {search.isLoading ? (
          <View className="items-center justify-center py-10">
            <Loading className="text-primary" size="small" style={{ flex: undefined }} />
          </View>
        ) : search.isError ? (
          <Text className="text-muted-foreground text-[15px] text-center py-10">
            {t('compose.podcast.searchError')}
          </Text>
        ) : !search.hasQuery ? (
          <Text className="text-muted-foreground text-[15px] text-center py-10">
            {t('compose.podcast.searchHint')}
          </Text>
        ) : search.results.length === 0 ? (
          <View className="items-center justify-center py-10 gap-2">
            <RiSearchLine size="2xl" fill={colors.textSecondary} />
            <Text className="text-muted-foreground text-[15px]">
              {t('compose.podcast.empty')}
            </Text>
          </View>
        ) : (
          <FlatList
            data={search.results}
            keyExtractor={(item) => item.syraPodcastId}
            renderItem={({ item }) => <PodcastResultRow result={item} onSelect={handleSelect} />}
            className="max-h-[340px]"
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onEndReached={search.loadMore}
            onEndReachedThreshold={0.4}
            ListFooterComponent={<ResultsFooter loading={search.isFetchingNextPage} />}
          />
        )}
      </View>
    </View>
  );
});

export default PodcastPickerSheet;
