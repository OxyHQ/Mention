import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Item } from '@oxyhq/bloom/item';
import { useTheme } from '@oxyhq/bloom/theme';
import { show as toast } from '@oxyhq/bloom/toast';
import {
  MagnifyingGlass_Stroke2_Corner0_Rounded,
  MagnifyingGlassX_Stroke2_Corner0_Rounded,
  CircleX_Stroke2_Corner0_Rounded,
  MusicNote_Stroke2_Corner0_Rounded,
  SpeakerVolumeFull_Stroke2_Corner0_Rounded,
  Trash_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';
import { api } from '@/utils/api';
import { useAppearanceStore, type ProfileMedia, type UserAppearance } from '@/store/appearanceStore';
import { useProfileSongPreview } from '@/hooks/useProfileSongPreview';
import { createScopedLogger } from '@/lib/logger';
import { SongPreviewButton } from './SongPreviewButton';

const logger = createScopedLogger('MediaPickerSheet');

// The public Syra preview is a fixed 30s clip; the start offset is bounded so
// the whole window stays inside the track. Mirrors the backend clamp.
const PREVIEW_WINDOW_SEC = 30;
const START_STEP_SEC = 5;
const SEARCH_DEBOUNCE_MS = 350;

type MediaTab = 'song' | 'podcast';

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

/**
 * One page of catalog search rows plus the offset to request next. The proxy
 * returns a `{ data, pagination }` envelope which `@oxyhq/core`'s HttpService
 * leaves un-unwrapped (the `pagination` key suppresses the `{ data }` unwrap),
 * so the rows live at `res.data.data` and the page metadata at
 * `res.data.pagination`. `nextOffset` advances by the page size (`limit`), not
 * by `rows.length`: the SDK can return a short page while more results remain.
 */
interface SearchResultPage<T> {
  rows: T[];
  hasMore: boolean;
  nextOffset: number;
}

interface PaginatedSearchEnvelope<T> {
  data: T[];
  pagination: { hasMore: boolean; offset: number; limit: number };
}

async function fetchSongPage(query: string, offset: number): Promise<SearchResultPage<SongSearchResult>> {
  const res = await api.get<PaginatedSearchEnvelope<SongSearchResult>>('profile/media/search', {
    type: 'song',
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

async function fetchPodcastPage(query: string, offset: number): Promise<SearchResultPage<PodcastSearchResult>> {
  const res = await api.get<PaginatedSearchEnvelope<PodcastSearchResult>>('profile/media/search', {
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

function formatStartTime(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
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
  const { colors } = useTheme();
  const preview = useProfileSongPreview(result.previewUrl);

  const handlePress = useCallback(() => {
    onSelect(result);
    preview.toggle();
  }, [onSelect, result, preview]);

  return (
    <Item
      selected={isSelected}
      onPress={handlePress}
      title={result.title}
      subtitle={result.artist}
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
            <MusicNote_Stroke2_Corner0_Rounded size="md" fill={colors.textSecondary} />
          </View>
        )
      }
      trailing={
        result.previewUrl ? (
          <SongPreviewButton
            isPlaying={preview.isPlaying}
            isLoading={preview.isLoading}
            onPress={handlePress}
            size="sm"
            accessibilityLabel={preview.isPlaying ? t('profile.media.song.pause') : t('profile.media.song.play')}
          />
        ) : undefined
      }
    />
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
  const { colors } = useTheme();

  const handlePress = useCallback(() => {
    onSelect(result);
  }, [onSelect, result]);

  return (
    <Item
      selected={isSelected}
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

/** Spinner shown at the bottom of a results list while the next page loads. */
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

/**
 * Owner media picker rendered inside Mention's shared bottom sheet. A SONG /
 * PODCAST toggle switches between two flows over the same Syra catalog proxy
 * (`profile/media/search?type=`):
 * - Song: audition a result, choose a 30s start offset, save `{type:'song'}`.
 * - Podcast: pick a show (no preview, no start), save `{type:'podcast'}`.
 * Saving either kind replaces the other (the backend stores a single field), and
 * "Remove" clears it. Mirrors `LinkSummary`'s sheet shell + debounced search.
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
  const [debouncedQuery, setDebouncedQuery] = useState('');
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

  // Debounce the raw input into the query key (the only effect here — React
  // Query owns the actual fetch, dedupe, and caching).
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const switchTab = useCallback((next: MediaTab) => {
    // Each tab searches a different catalog type, so clear the query when
    // switching. Per-tab selections persist so toggling back keeps the pick.
    setTab(next);
    setQuery('');
    setDebouncedQuery('');
  }, []);

  const songSearch = useInfiniteQuery({
    queryKey: ['profile-media-search', 'song', debouncedQuery],
    queryFn: ({ pageParam }) => fetchSongPage(debouncedQuery, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset : undefined),
    enabled: tab === 'song' && debouncedQuery.length > 0,
    staleTime: 60_000,
  });
  const podcastSearch = useInfiniteQuery({
    queryKey: ['profile-media-search', 'podcast', debouncedQuery],
    queryFn: ({ pageParam }) => fetchPodcastPage(debouncedQuery, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset : undefined),
    enabled: tab === 'podcast' && debouncedQuery.length > 0,
    staleTime: 60_000,
  });

  const songResults = useMemo(
    () => songSearch.data?.pages.flatMap((page) => page.rows) ?? [],
    [songSearch.data],
  );
  const podcastResults = useMemo(
    () => podcastSearch.data?.pages.flatMap((page) => page.rows) ?? [],
    [podcastSearch.data],
  );

  const loadMoreSongs = useCallback(() => {
    if (songSearch.hasNextPage && !songSearch.isFetchingNextPage) {
      void songSearch.fetchNextPage();
    }
  }, [songSearch.hasNextPage, songSearch.isFetchingNextPage, songSearch.fetchNextPage]);

  const loadMorePodcasts = useCallback(() => {
    if (podcastSearch.hasNextPage && !podcastSearch.isFetchingNextPage) {
      void podcastSearch.fetchNextPage();
    }
  }, [podcastSearch.hasNextPage, podcastSearch.isFetchingNextPage, podcastSearch.fetchNextPage]);

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
      logger.error('Failed to save profile media', { error: message });
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
      logger.error('Failed to remove profile media', { error: message });
      toast(message || t('profile.media.saveError'), { type: 'error' });
    }
  }, [saving, updateMySettings, t, onClose]);

  const isSongTab = tab === 'song';
  const activeSearch = isSongTab ? songSearch : podcastSearch;

  return (
    <View className="bg-background px-4 pt-3 pb-2">
      <Text className="text-foreground text-lg font-bold mb-3">
        {t('profile.media.title')}
      </Text>

      {/* SONG / PODCAST toggle */}
      <View className="flex-row p-1 rounded-full bg-secondary mb-3">
        <Pressable
          onPress={() => switchTab('song')}
          accessibilityRole="button"
          accessibilityState={{ selected: isSongTab }}
          accessibilityLabel={t('profile.media.tabSong')}
          className="flex-1 py-2 rounded-full items-center justify-center"
          style={{ backgroundColor: isSongTab ? colors.background : 'transparent' }}
        >
          <Text
            className="text-[14px] font-semibold"
            style={{ color: isSongTab ? colors.text : colors.textSecondary }}
          >
            {t('profile.media.tabSong')}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => switchTab('podcast')}
          accessibilityRole="button"
          accessibilityState={{ selected: !isSongTab }}
          accessibilityLabel={t('profile.media.tabPodcast')}
          className="flex-1 py-2 rounded-full items-center justify-center"
          style={{ backgroundColor: !isSongTab ? colors.background : 'transparent' }}
        >
          <Text
            className="text-[14px] font-semibold"
            style={{ color: !isSongTab ? colors.text : colors.textSecondary }}
          >
            {t('profile.media.tabPodcast')}
          </Text>
        </Pressable>
      </View>

      {/* Search input — mirrors GifPickerSheet's styled search row. */}
      <View className="flex-row items-center px-3 py-2.5 rounded-xl bg-secondary gap-2.5">
        <MagnifyingGlass_Stroke2_Corner0_Rounded size="sm" fill={colors.textSecondary} />
        <TextInput
          className="flex-1 text-[15px] text-foreground"
          placeholder={isSongTab ? t('profile.media.song.searchPlaceholder') : t('profile.media.podcast.searchPlaceholder')}
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
        {activeSearch.isLoading ? (
          <View className="items-center justify-center py-10">
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        ) : activeSearch.isError ? (
          <Text className="text-muted-foreground text-[15px] text-center py-10">
            {isSongTab ? t('profile.media.song.searchError') : t('profile.media.podcast.searchError')}
          </Text>
        ) : debouncedQuery.length === 0 ? (
          <Text className="text-muted-foreground text-[15px] text-center py-10">
            {isSongTab ? t('profile.media.song.searchHint') : t('profile.media.podcast.searchHint')}
          </Text>
        ) : isSongTab ? (
          songResults.length === 0 ? (
            <View className="items-center justify-center py-10 gap-2">
              <MagnifyingGlassX_Stroke2_Corner0_Rounded size="xl" fill={colors.textSecondary} />
              <Text className="text-muted-foreground text-[15px]">
                {t('profile.media.song.empty')}
              </Text>
            </View>
          ) : (
            <FlatList
              data={songResults}
              keyExtractor={(item) => item.syraTrackId}
              renderItem={({ item }) => (
                <SongResultRow
                  result={item}
                  isSelected={selectedSong?.syraTrackId === item.syraTrackId}
                  onSelect={handleSelectSong}
                />
              )}
              className="max-h-[300px]"
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              onEndReached={loadMoreSongs}
              onEndReachedThreshold={0.4}
              ListFooterComponent={<ResultsFooter loading={songSearch.isFetchingNextPage} />}
            />
          )
        ) : podcastResults.length === 0 ? (
          <View className="items-center justify-center py-10 gap-2">
            <MagnifyingGlassX_Stroke2_Corner0_Rounded size="xl" fill={colors.textSecondary} />
            <Text className="text-muted-foreground text-[15px]">
              {t('profile.media.podcast.empty')}
            </Text>
          </View>
        ) : (
          <FlatList
            data={podcastResults}
            keyExtractor={(item) => item.syraPodcastId}
            renderItem={({ item }) => (
              <PodcastResultRow
                result={item}
                isSelected={selectedPodcast?.syraPodcastId === item.syraPodcastId}
                onSelect={handleSelectPodcast}
              />
            )}
            className="max-h-[300px]"
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onEndReached={loadMorePodcasts}
            onEndReachedThreshold={0.4}
            ListFooterComponent={<ResultsFooter loading={podcastSearch.isFetchingNextPage} />}
          />
        )}
      </View>

      {/* Selected song — start offset + save */}
      {isSongTab && selectedSong && (
        <View className="bg-secondary rounded-xl p-3 mt-2">
          <View className="flex-row items-center gap-3">
            {selectedSong.artworkUrl ? (
              <Image
                source={{ uri: selectedSong.artworkUrl }}
                style={{ width: 40, height: 40, borderRadius: 6 }}
                contentFit="cover"
                transition={120}
              />
            ) : (
              <View
                className="rounded-md bg-background items-center justify-center"
                style={{ width: 40, height: 40 }}
              >
                <MusicNote_Stroke2_Corner0_Rounded size="md" fill={colors.textSecondary} />
              </View>
            )}
            <View className="flex-1 shrink">
              <Text className="text-foreground text-[15px] font-semibold" numberOfLines={1}>
                {selectedSong.title}
              </Text>
              <Text className="text-muted-foreground text-[13px]" numberOfLines={1}>
                {selectedSong.artist}
              </Text>
            </View>
          </View>

          {maxStartSec > 0 && (
            <View className="flex-row items-center justify-between mt-3">
              <Text className="text-muted-foreground text-[13px]">
                {t('profile.media.song.startsAt', { time: formatStartTime(startSec) })}
              </Text>
              <View className="flex-row items-center gap-3">
                <Pressable
                  onPress={decrementStart}
                  disabled={startSec <= 0}
                  accessibilityRole="button"
                  accessibilityLabel={t('profile.media.song.startEarlier')}
                  hitSlop={8}
                  className="rounded-full bg-background items-center justify-center"
                  style={{ width: 32, height: 32, opacity: startSec <= 0 ? 0.4 : 1 }}
                >
                  <Text className="text-foreground text-lg font-semibold leading-none">{'−'}</Text>
                </Pressable>
                <Text className="text-foreground text-[15px] font-semibold tabular-nums">
                  {formatStartTime(startSec)}
                </Text>
                <Pressable
                  onPress={incrementStart}
                  disabled={startSec >= maxStartSec}
                  accessibilityRole="button"
                  accessibilityLabel={t('profile.media.song.startLater')}
                  hitSlop={8}
                  className="rounded-full bg-background items-center justify-center"
                  style={{ width: 32, height: 32, opacity: startSec >= maxStartSec ? 0.4 : 1 }}
                >
                  <Text className="text-foreground text-lg font-semibold leading-none">+</Text>
                </Pressable>
              </View>
            </View>
          )}

          <Pressable
            onPress={handleSaveSong}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel={t('profile.media.save')}
            className="mt-3 rounded-full bg-primary py-2.5 items-center justify-center"
            style={{ opacity: saving ? 0.6 : 1 }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Text className="text-[15px] font-semibold" style={{ color: colors.primaryForeground }}>
                {t('profile.media.save')}
              </Text>
            )}
          </Pressable>
        </View>
      )}

      {/* Selected podcast — save (no start offset, no preview) */}
      {!isSongTab && selectedPodcast && (
        <View className="bg-secondary rounded-xl p-3 mt-2">
          <View className="flex-row items-center gap-3">
            {selectedPodcast.artworkUrl ? (
              <Image
                source={{ uri: selectedPodcast.artworkUrl }}
                style={{ width: 40, height: 40, borderRadius: 6 }}
                contentFit="cover"
                transition={120}
              />
            ) : (
              <View
                className="rounded-md bg-background items-center justify-center"
                style={{ width: 40, height: 40 }}
              >
                <SpeakerVolumeFull_Stroke2_Corner0_Rounded size="md" fill={colors.textSecondary} />
              </View>
            )}
            <View className="flex-1 shrink">
              <Text className="text-foreground text-[15px] font-semibold" numberOfLines={1}>
                {selectedPodcast.title}
              </Text>
              {selectedPodcast.author ? (
                <Text className="text-muted-foreground text-[13px]" numberOfLines={1}>
                  {selectedPodcast.author}
                </Text>
              ) : null}
            </View>
          </View>

          <Pressable
            onPress={handleSavePodcast}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel={t('profile.media.save')}
            className="mt-3 rounded-full bg-primary py-2.5 items-center justify-center"
            style={{ opacity: saving ? 0.6 : 1 }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Text className="text-[15px] font-semibold" style={{ color: colors.primaryForeground }}>
                {t('profile.media.save')}
              </Text>
            )}
          </Pressable>
        </View>
      )}

      {/* Remove the currently pinned media (song or podcast) */}
      {currentMedia && (
        <Pressable
          onPress={handleRemove}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel={t('profile.media.remove')}
          className="flex-row items-center justify-center gap-2 mt-3 py-2.5"
        >
          <Trash_Stroke2_Corner0_Rounded size="sm" fill={colors.error} />
          <Text className="text-[15px] font-semibold" style={{ color: colors.error }}>
            {t('profile.media.remove')}
          </Text>
        </Pressable>
      )}
    </View>
  );
});
