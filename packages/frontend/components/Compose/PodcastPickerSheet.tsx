import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { memo, useCallback, useState } from 'react';
import { FlatList, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { RiMic2Line } from '@oxy.so/bloom/icons/RiMic2Line';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { useInfiniteCatalogSearch, ResultsFooter } from '@/hooks/useInfiniteCatalogSearch';
import type { PodcastAttachmentData } from '@/hooks/usePodcastManager';

import { Embed, Icon, RawText, VStack, toElement } from '@oxy.so/bloom-language';
import { Row } from '@oxy.so/bloom-language/containers';
import { Search as LSearch } from '@oxy.so/bloom-language/inputs';

/** The sheet's list stops growing at 340pt (`max-h-[340px]`): the results scroll inside it. */
const LIST_STYLE = { maxHeight: 340 } satisfies ViewStyle;

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

  return toElement(
    Row(result.title)
      .onPress(handlePress)
      .subtitle(result.author)
      .leadingView(
        Embed(
          result.artworkUrl ? (
            <Image
              source={{ uri: result.artworkUrl }}
              style={{ width: 40, height: 40, borderRadius: 6 }}
              contentFit="cover"
              transition={120}
            />
          ) : (
            toElement(
              VStack(Icon(RiMic2Line).size('md').foreground('muted'))
                .frame({ width: '4xl', height: '4xl' })
                .background('mutedFill')
                // The app's `rounded-md` (its radius less 2px) reached only the web.
                .when('web', (v) => v.corner('14'))
                .align('center')
                .justify('center'),
            )
          ),
        ),
      ),
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
      });
      onClose();
    },
    [onSelect, onClose],
  );

  return toElement(
    VStack(
      RawText(t('compose.podcast.title'))
        .foreground('foreground')
        .font('18')
        .leading('28px')
        .weight('bold')
        .margin('bottom', 'md'),
      LSearch([query, setQuery])
        .label(t('compose.podcast.searchPlaceholder'))
        .onClearText(() => setQuery(''))
        .autocapitalize('none')
        .autocorrect(false),
      /* Results */ VStack(
        Embed(
          search.isLoading ? (
            <ListSkeleton />
          ) : search.isError ? (
            toElement(
              RawText(t('compose.podcast.searchError'))
                .padding('vertical', '4xl')
                .foreground('muted')
                .font('md')
                .textAlign('center'),
            )
          ) : !search.hasQuery ? (
            toElement(
              RawText(t('compose.podcast.searchHint'))
                .padding('vertical', '4xl')
                .foreground('muted')
                .font('md')
                .textAlign('center'),
            )
          ) : search.results.length === 0 ? (
            toElement(
              VStack(
                Icon(RiSearchLine).size('2xl').foreground('muted'),
                RawText(t('compose.podcast.empty')).foreground('muted').font('md'),
              )
                .padding('vertical', '4xl')
                .align('center')
                .justify('center')
                .spacing('sm'),
            )
          ) : (
            <FlatList
              data={search.results}
              keyExtractor={(item) => item.syraPodcastId}
              renderItem={({ item }) => <PodcastResultRow result={item} onSelect={handleSelect} />}
              style={LIST_STYLE}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              onEndReached={search.loadMore}
              onEndReachedThreshold={0.4}
              ListFooterComponent={<ResultsFooter loading={search.isFetchingNextPage} />}
            />
          ),
        ),
      )
        .frame({ minHeight: '120' })
        .margin('top', 'sm'),
    )
      .padding('horizontal', 'lg')
      .padding('top', 'md')
      .padding('bottom', 'sm')
      .background('background'),
  );
});

export default PodcastPickerSheet;
