import { tokens } from '@oxy.so/bloom/styles';
import { MediaGridSkeleton } from '@/components/loading/ContentSkeleton';
import { memo, useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  TextInput,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiMic2Line } from '@oxy.so/bloom/icons/RiMic2Line';
import { RiMusic2Line } from '@oxy.so/bloom/icons/RiMusic2Line';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import {
  useAppearanceStore,
  type ProfileMedia,
  type UserAppearance,
} from '@/stores/appearanceStore';
import { useProfileSongPreview } from '@/hooks/useProfileSongPreview';
import { useInfiniteCatalogSearch, ResultsFooter } from '@/hooks/useInfiniteCatalogSearch';
import { createLogger } from '@oxy.so/core/logger';
import { formatDuration } from '@/utils/formatDuration';
import { SongPreviewButton } from './SongPreviewButton';
import {
  Embed,
  HStack,
  Icon,
  type IconComponent,
  RawText,
  Row,
  SpinnerIcon,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const logger = createLogger('MediaPickerSheet');

// The public Syra preview is a fixed 30s clip; the start offset is bounded so
// the whole window stays inside the track. Mirrors the backend clamp.
const PREVIEW_WINDOW_SEC = 30;
const START_STEP_SEC = 5;

type MediaTab = 'song' | 'podcast';

/** Rounded only on the web: the app's `rounded-md` reads `--radius`, which native never had. */
function artworkPlaceholder(icon: IconComponent, fill: 'mutedFill' | 'background') {
  return VStack(Icon(icon).size('md').foreground('muted'))
    .frame({ width: '4xl', height: '4xl' })
    .background(fill)
    .when('web', (v) => v.corner('14'))
    .align('center')
    .justify('center');
}

/** A SONG / PODCAST tab: the selected one sits on the sheet's background. */
function mediaTab(label: string, selected: boolean, onPress: () => void) {
  return VStack(
    RawText(label)
      .font('14')
      .weight('semibold')
      .foreground(selected ? 'foreground' : 'muted'),
  )
    .flex('1')
    .padding('vertical', 'sm')
    .align('center')
    .justify('center')
    .background(selected ? 'background' : 'transparent')
    .corner('infinite')
    .onPress(onPress)
    .role('button')
    .accessibilityState({ selected })
    .label(label);
}

/**
 * The start offset, 15pt semibold. Its digits are of one width on the web only: NativeWind wrote
 * `tabular-nums` as a web style, and a variant cannot change the digits, so the platform picks.
 */
function startOffsetLabel(time: string) {
  const label = RawText(time).foreground('foreground').font('md').weight('semibold');
  return Platform.OS === 'web' ? label.monospacedDigit() : label;
}

/** A start-offset step: its glyph on a 32pt disc, faded and inert at the window's edge. */
function startStepButton(glyph: string, atEdge: boolean) {
  return VStack(
    RawText(glyph).foreground('foreground').font('18').leading('18px').weight('semibold'),
  )
    .frame({ width: '3xl', height: '3xl' })
    .background('background')
    .corner('infinite')
    .opacity(atEdge ? '40' : 'opaque')
    .align('center')
    .justify('center')
    .disabled(atEdge)
    .role('button')
    .hitSlop('md');
}

interface SongSearchResult {
  syraTrackId: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  durationSec?: number;
  previewAvailable: boolean;
  // The search endpoint guarantees `previewAvailable`; `previewUrl` is only
  // present when the catalog can supply a pre-save audition. The preview button
  // renders only when the URL is present — no URL means no in-picker preview.
  previewUrl?: string;
}

interface PodcastSearchResult {
  syraPodcastId: string;
  title: string;
  author?: string;
  artworkUrl?: string;
}

/** The track the owner is about to pin. Unifies a song search hit and the current song. */
interface SongSelection {
  syraTrackId: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  previewUrl?: string;
  durationSec?: number;
}

/** The show the owner is about to pin. Unifies a podcast search hit and the current podcast. */
interface PodcastSelection {
  syraPodcastId: string;
  title: string;
  author?: string;
  artworkUrl?: string;
}

interface MediaPickerSheetProps {
  currentMedia: ProfileMedia | null;
  onClose: () => void;
}

function songSelectionFromMedia(media: ProfileMedia | null): SongSelection | null {
  if (!media || media.type !== 'song') {
    return null;
  }
  return {
    syraTrackId: media.syraTrackId,
    title: media.title,
    artist: media.artist,
    artworkUrl: media.artworkUrl,
    previewUrl: media.previewUrl,
    durationSec: media.durationSec,
  };
}

function podcastSelectionFromMedia(media: ProfileMedia | null): PodcastSelection | null {
  if (!media || media.type !== 'podcast') {
    return null;
  }
  return {
    syraPodcastId: media.syraPodcastId,
    title: media.title,
    author: media.author,
    artworkUrl: media.artworkUrl,
  };
}

/**
 * A single song search result row. Owns its own preview so tapping it auditions
 * the track (the module-level coordinator in `useProfileSongPreview` guarantees a
 * single preview plays at a time). Tapping the row also selects the track as the
 * save candidate.
 */
const SongResultRow = memo(function SongResultRow({
  result,
  isSelected,
  onSelect,
}: {
  result: SongSearchResult;
  isSelected: boolean;
  onSelect: (result: SongSearchResult) => void;
}) {
  const { t } = useTranslation();
  const preview = useProfileSongPreview(result.previewUrl);

  const handlePress = useCallback(() => {
    onSelect(result);
    preview.toggle();
  }, [onSelect, result, preview]);

  return toElement(
    Row(result.title)
      .selected(isSelected)
      .onPress(handlePress)
      .subtitle(result.artist)
      .leadingView(
        result.artworkUrl
          ? Embed(
              <Image
                source={{ uri: result.artworkUrl }}
                style={{ width: 40, height: 40, borderRadius: 6 }}
                contentFit="cover"
                transition={120}
              />,
            )
          : artworkPlaceholder(RiMusic2Line, 'mutedFill'),
      )
      .trailing(
        Embed(
          result.previewUrl ? (
            <SongPreviewButton
              isPlaying={preview.isPlaying}
              isLoading={preview.isLoading}
              onPress={handlePress}
              size="sm"
              accessibilityLabel={
                preview.isPlaying ? t('profile.media.song.pause') : t('profile.media.song.play')
              }
            />
          ) : undefined,
        ),
      ),
  );
});

/** A single podcast search result row. No preview — selecting it picks the show. */
const PodcastResultRow = memo(function PodcastResultRow({
  result,
  isSelected,
  onSelect,
}: {
  result: PodcastSearchResult;
  isSelected: boolean;
  onSelect: (result: PodcastSearchResult) => void;
}) {
  const handlePress = useCallback(() => {
    onSelect(result);
  }, [onSelect, result]);

  return toElement(
    Row(result.title)
      .selected(isSelected)
      .onPress(handlePress)
      .subtitle(result.author)
      .leadingView(
        result.artworkUrl
          ? Embed(
              <Image
                source={{ uri: result.artworkUrl }}
                style={{ width: 40, height: 40, borderRadius: 6 }}
                contentFit="cover"
                transition={120}
              />,
            )
          : artworkPlaceholder(RiMic2Line, 'mutedFill'),
      ),
  );
});

/**
 * Owner media picker rendered inside Mention's shared bottom sheet. A SONG /
 * PODCAST toggle switches between two flows over the same Syra catalog proxy
 * (`profile/media/search?type=`):
 * - Song: audition a result, choose a 30s start offset, save `{type:'song'}`.
 * - Podcast: pick a show (no preview, no start), save `{type:'podcast'}`.
 * Saving either kind replaces the other (the backend stores a single field), and
 * "Remove" clears it. Mirrors `ProfileLinkChips`' sheet shell + debounced search.
 */
export const MediaPickerSheet = memo(function MediaPickerSheet({
  currentMedia,
  onClose,
}: MediaPickerSheetProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);

  const [tab, setTab] = useState<MediaTab>(() => currentMedia?.type ?? 'song');
  const [query, setQuery] = useState('');
  const [selectedSong, setSelectedSong] = useState<SongSelection | null>(() =>
    songSelectionFromMedia(currentMedia),
  );
  const [startSec, setStartSec] = useState<number>(() =>
    currentMedia?.type === 'song' ? currentMedia.startSec : 0,
  );
  const [selectedPodcast, setSelectedPodcast] = useState<PodcastSelection | null>(() =>
    podcastSelectionFromMedia(currentMedia),
  );
  const [saving, setSaving] = useState(false);

  const switchTab = useCallback((next: MediaTab) => {
    // Each tab searches a different catalog type, so clear the query when
    // switching. Per-tab selections persist so toggling back keeps the pick.
    setTab(next);
    setQuery('');
  }, []);

  // One paginated, debounced search per facet. Each hook only sees the shared
  // input while its tab is active (`tab === '…' ? query : ''`); an inactive
  // facet therefore keeps an empty debounced query, so toggling tabs never
  // flashes the other tab's results or fires a stale fetch before the debounce
  // catches up to the just-cleared input.
  const songSearch = useInfiniteCatalogSearch<SongSearchResult>(
    'song',
    tab === 'song' ? query : '',
    { enabled: tab === 'song' },
  );
  const podcastSearch = useInfiniteCatalogSearch<PodcastSearchResult>(
    'podcast',
    tab === 'podcast' ? query : '',
    { enabled: tab === 'podcast' },
  );

  const maxStartSec = useMemo(
    () => Math.max(0, Math.floor(selectedSong?.durationSec ?? 0) - PREVIEW_WINDOW_SEC),
    [selectedSong?.durationSec],
  );

  const handleSelectSong = useCallback((result: SongSearchResult) => {
    setSelectedSong({
      syraTrackId: result.syraTrackId,
      title: result.title,
      artist: result.artist,
      artworkUrl: result.artworkUrl,
      previewUrl: result.previewUrl,
      durationSec: result.durationSec,
    });
    setStartSec(0);
  }, []);

  const handleSelectPodcast = useCallback((result: PodcastSearchResult) => {
    setSelectedPodcast({
      syraPodcastId: result.syraPodcastId,
      title: result.title,
      author: result.author,
      artworkUrl: result.artworkUrl,
    });
  }, []);

  const decrementStart = useCallback(() => {
    setStartSec((prev) => Math.max(0, prev - START_STEP_SEC));
  }, []);

  const incrementStart = useCallback(() => {
    setStartSec((prev) => Math.min(maxStartSec, prev + START_STEP_SEC));
  }, [maxStartSec]);

  const finishSave = useCallback(
    (updated: UserAppearance | null) => {
      if (updated) {
        toast(t('profile.media.saved'), { type: 'success' });
        onClose();
        return;
      }
      const message = useAppearanceStore.getState().error;
      logger.error('Failed to save profile media', message);
      toast(message || t('profile.media.saveError'), { type: 'error' });
    },
    [t, onClose],
  );

  const handleSaveSong = useCallback(async () => {
    if (!selectedSong || saving) {
      return;
    }
    setSaving(true);
    const updated = await updateMySettings({
      profileMedia: { type: 'song', syraTrackId: selectedSong.syraTrackId, startSec },
    });
    setSaving(false);
    finishSave(updated);
  }, [selectedSong, saving, startSec, updateMySettings, finishSave]);

  const handleSavePodcast = useCallback(async () => {
    if (!selectedPodcast || saving) {
      return;
    }
    setSaving(true);
    const updated = await updateMySettings({
      profileMedia: { type: 'podcast', syraPodcastId: selectedPodcast.syraPodcastId },
    });
    setSaving(false);
    finishSave(updated);
  }, [selectedPodcast, saving, updateMySettings, finishSave]);

  const handleRemove = useCallback(async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    const updated = await updateMySettings({ profileMedia: null });
    setSaving(false);
    if (updated) {
      toast(t('profile.media.removed'), { type: 'success' });
      onClose();
    } else {
      const message = useAppearanceStore.getState().error;
      logger.error('Failed to remove profile media', message);
      toast(message || t('profile.media.saveError'), { type: 'error' });
    }
  }, [saving, updateMySettings, t, onClose]);

  const isSongTab = tab === 'song';
  const activeSearch = isSongTab ? songSearch : podcastSearch;

  return toElement(
    VStack(
      RawText(t('profile.media.title'))
        .foreground('foreground')
        .font('18')
        .leading('28px')
        .weight('bold')
        .margin('bottom', 'md'),
      /* SONG / PODCAST toggle */ HStack(
        mediaTab(t('profile.media.tabSong'), isSongTab, () => switchTab('song')),
        mediaTab(t('profile.media.tabPodcast'), !isSongTab, () => switchTab('podcast')),
      )
        .padding('all', 'xs')
        .background('mutedFill')
        .corner('infinite')
        .margin('bottom', 'md'),
      /* Search input — mirrors GifPickerSheet's styled search row. */ HStack(
        Icon(RiSearchLine).size('sm').foreground('muted'),
        Embed(
          <TextInput
            style={[SEARCH_INPUT_STYLE, { color: colors.text }]}
            placeholder={
              isSongTab
                ? t('profile.media.song.searchPlaceholder')
                : t('profile.media.podcast.searchPlaceholder')
            }
            placeholderTextColor={colors.textTertiary}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />,
        ),
        Embed(
          query.length > 0 && (
            <Pressable
              onPress={() => setQuery('')}
              accessibilityRole="button"
              accessibilityLabel={t('profile.media.clearSearch')}
              hitSlop={tokens.hitSlop.md}
            >
              {toElement(Icon(RiCloseCircleLine).size('sm').foreground('muted'))}
            </Pressable>
          ),
        ),
      )
        .padding('horizontal', 'md')
        .padding('vertical', '10')
        .background('mutedFill')
        .corner('md')
        .align('center')
        .spacing('10'),
      /* Results */ VStack(
        Embed(
          activeSearch.isLoading ? (
            <MediaGridSkeleton />
          ) : activeSearch.isError ? (
            toElement(
              RawText(
                isSongTab
                  ? t('profile.media.song.searchError')
                  : t('profile.media.podcast.searchError'),
              )
                .padding('vertical', '4xl')
                .foreground('muted')
                .font('md')
                .textAlign('center'),
            )
          ) : !activeSearch.hasQuery ? (
            toElement(
              RawText(
                isSongTab
                  ? t('profile.media.song.searchHint')
                  : t('profile.media.podcast.searchHint'),
              )
                .padding('vertical', '4xl')
                .foreground('muted')
                .font('md')
                .textAlign('center'),
            )
          ) : isSongTab ? (
            songSearch.results.length === 0 ? (
              toElement(
                VStack(
                  Icon(RiSearchLine).size('2xl').foreground('muted'),
                  RawText(t('profile.media.song.empty')).foreground('muted').font('md'),
                )
                  .padding('vertical', '4xl')
                  .align('center')
                  .justify('center')
                  .spacing('sm'),
              )
            ) : (
              <FlatList
                data={songSearch.results}
                keyExtractor={(item) => item.syraTrackId}
                renderItem={({ item }) => (
                  <SongResultRow
                    result={item}
                    isSelected={selectedSong?.syraTrackId === item.syraTrackId}
                    onSelect={handleSelectSong}
                  />
                )}
                style={RESULTS_STYLE}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                onEndReached={songSearch.loadMore}
                onEndReachedThreshold={0.4}
                ListFooterComponent={<ResultsFooter loading={songSearch.isFetchingNextPage} />}
              />
            )
          ) : podcastSearch.results.length === 0 ? (
            toElement(
              VStack(
                Icon(RiSearchLine).size('2xl').foreground('muted'),
                RawText(t('profile.media.podcast.empty')).foreground('muted').font('md'),
              )
                .padding('vertical', '4xl')
                .align('center')
                .justify('center')
                .spacing('sm'),
            )
          ) : (
            <FlatList
              data={podcastSearch.results}
              keyExtractor={(item) => item.syraPodcastId}
              renderItem={({ item }) => (
                <PodcastResultRow
                  result={item}
                  isSelected={selectedPodcast?.syraPodcastId === item.syraPodcastId}
                  onSelect={handleSelectPodcast}
                />
              )}
              style={RESULTS_STYLE}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              onEndReached={podcastSearch.loadMore}
              onEndReachedThreshold={0.4}
              ListFooterComponent={<ResultsFooter loading={podcastSearch.isFetchingNextPage} />}
            />
          ),
        ),
      )
        .frame({ minHeight: '120' })
        .margin('top', 'sm'),
      /* Selected song — start offset + save */ Embed(
        isSongTab &&
          selectedSong &&
          toElement(
            VStack(
              HStack(
                selectedSong.artworkUrl
                  ? Embed(
                      <Image
                        source={{ uri: selectedSong.artworkUrl }}
                        style={{ width: 40, height: 40, borderRadius: 6 }}
                        contentFit="cover"
                        transition={120}
                      />,
                    )
                  : artworkPlaceholder(RiMusic2Line, 'background'),
                VStack(
                  RawText(selectedSong.title)
                    .foreground('foreground')
                    .font('md')
                    .weight('semibold')
                    .lines(1),
                  RawText(selectedSong.artist).foreground('muted').font('sm').lines(1),
                )
                  .flex('1')
                  .shrink('normal'),
              )
                .align('center')
                .spacing('md'),
              maxStartSec > 0
                ? HStack(
                    RawText(t('profile.media.song.startsAt', { time: formatDuration(startSec) }))
                      .foreground('muted')
                      .font('sm'),
                    HStack(
                      startStepButton('−', startSec <= 0)
                        .onPress(decrementStart)
                        .label(t('profile.media.song.startEarlier')),
                      startOffsetLabel(formatDuration(startSec)),
                      startStepButton('+', startSec >= maxStartSec)
                        .onPress(incrementStart)
                        .label(t('profile.media.song.startLater')),
                    )
                      .align('center')
                      .spacing('md'),
                  )
                    .align('center')
                    .justify('between')
                    .margin('top', 'md')
                : null,
              VStack(
                saving
                  ? SpinnerIcon().size('md').tint('onPrimary')
                  : RawText(t('profile.media.save'))
                      .font('md')
                      .weight('semibold')
                      .foreground('onPrimary'),
              )
                .padding('vertical', '10')
                .background('primary')
                .corner('infinite')
                .opacity(saving ? '60' : 'opaque')
                .align('center')
                .justify('center')
                .margin('top', 'md')
                .onPress(handleSaveSong)
                .disabled(saving)
                .role('button')
                .label(t('profile.media.save')),
            )
              .padding('all', 'md')
              .background('mutedFill')
              .corner('md')
              .margin('top', 'sm'),
          ),
      ),
      /* Selected podcast — save (no start offset, no preview) */ Embed(
        !isSongTab &&
          selectedPodcast &&
          toElement(
            VStack(
              HStack(
                selectedPodcast.artworkUrl
                  ? Embed(
                      <Image
                        source={{ uri: selectedPodcast.artworkUrl }}
                        style={{ width: 40, height: 40, borderRadius: 6 }}
                        contentFit="cover"
                        transition={120}
                      />,
                    )
                  : artworkPlaceholder(RiMic2Line, 'background'),
                VStack(
                  RawText(selectedPodcast.title)
                    .foreground('foreground')
                    .font('md')
                    .weight('semibold')
                    .lines(1),
                  selectedPodcast.author
                    ? RawText(selectedPodcast.author).foreground('muted').font('sm').lines(1)
                    : null,
                )
                  .flex('1')
                  .shrink('normal'),
              )
                .align('center')
                .spacing('md'),
              VStack(
                saving
                  ? SpinnerIcon().size('md').tint('onPrimary')
                  : RawText(t('profile.media.save'))
                      .font('md')
                      .weight('semibold')
                      .foreground('onPrimary'),
              )
                .padding('vertical', '10')
                .background('primary')
                .corner('infinite')
                .opacity(saving ? '60' : 'opaque')
                .align('center')
                .justify('center')
                .margin('top', 'md')
                .onPress(handleSavePodcast)
                .disabled(saving)
                .role('button')
                .label(t('profile.media.save')),
            )
              .padding('all', 'md')
              .background('mutedFill')
              .corner('md')
              .margin('top', 'sm'),
          ),
      ),
      /* Remove the currently pinned media (song or podcast) */ Embed(
        currentMedia &&
          toElement(
            HStack(
              Icon(RiDeleteBinLine).size('sm').foreground('error'),
              RawText(t('profile.media.remove')).font('md').weight('semibold').foreground('error'),
            )
              .padding('vertical', '10')
              .align('center')
              .justify('center')
              .spacing('sm')
              .margin('top', 'md')
              .onPress(handleRemove)
              .disabled(saving)
              .role('button')
              .label(t('profile.media.remove')),
          ),
      ),
    )
      .padding('horizontal', 'lg')
      .padding('top', 'md')
      .padding('bottom', 'sm')
      .background('background'),
  );
});

/** Plain objects, not a StyleSheet: what NativeWind's classes drew, inline as they were. */
const SEARCH_INPUT_STYLE: TextStyle = { flexGrow: 1, flexShrink: 1, flexBasis: '0%', fontSize: 15 };
const RESULTS_STYLE: ViewStyle = { maxHeight: 300 };
