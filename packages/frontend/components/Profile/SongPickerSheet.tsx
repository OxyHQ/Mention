import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Item } from '@oxyhq/bloom/item';
import { useTheme } from '@oxyhq/bloom/theme';
import { show as toast } from '@oxyhq/bloom/toast';
import {
  MagnifyingGlass_Stroke2_Corner0_Rounded,
  MagnifyingGlassX_Stroke2_Corner0_Rounded,
  CircleX_Stroke2_Corner0_Rounded,
  MusicNote_Stroke2_Corner0_Rounded,
  Trash_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';
import { api } from '@/utils/api';
import { useAppearanceStore, type ProfileSong } from '@/store/appearanceStore';
import { useProfileSongPreview } from '@/hooks/useProfileSongPreview';
import { createScopedLogger } from '@/lib/logger';
import { SongPreviewButton } from './SongPreviewButton';

const logger = createScopedLogger('SongPickerSheet');

// The public Syra preview is a fixed 30s clip; the start offset is bounded so
// the whole window stays inside the track. Mirrors the backend clamp.
const PREVIEW_WINDOW_SEC = 30;
const START_STEP_SEC = 5;
const SEARCH_DEBOUNCE_MS = 350;

interface ProfileSongSearchResult {
  syraTrackId: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  durationSec?: number;
  previewAvailable: boolean;
  previewUrl?: string;
}

/** The track the owner is about to pin. Unifies a search hit and the current song. */
interface SongSelection {
  syraTrackId: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  previewUrl?: string;
  durationSec?: number;
}

interface SongPickerSheetProps {
  currentSong?: ProfileSong | null;
  onClose: () => void;
}

async function searchProfileSongs(query: string): Promise<ProfileSongSearchResult[]> {
  const res = await api.get<{ data: ProfileSongSearchResult[] }>('profile/song/search', { q: query });
  return Array.isArray(res.data?.data) ? res.data.data : [];
}

function formatStartTime(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function selectionFromSong(song: ProfileSong | null | undefined): SongSelection | null {
  if (!song) {
    return null;
  }
  return {
    syraTrackId: song.syraTrackId,
    title: song.title,
    artist: song.artist,
    artworkUrl: song.artworkUrl,
    previewUrl: song.previewUrl,
    durationSec: song.durationSec,
  };
}

/**
 * A single search result row. Owns its own preview so tapping it auditions the
 * track (the module-level coordinator in `useProfileSongPreview` guarantees a
 * single preview plays at a time). Tapping the row also selects the track as the
 * save candidate.
 */
const SongResultRow = memo(function SongResultRow({
  result,
  isSelected,
  onSelect,
}: {
  result: ProfileSongSearchResult;
  isSelected: boolean;
  onSelect: (result: ProfileSongSearchResult) => void;
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
            accessibilityLabel={preview.isPlaying ? t('profile.song.pause') : t('profile.song.play')}
          />
        ) : undefined
      }
    />
  );
});

/**
 * Owner song picker rendered inside Mention's shared bottom sheet. Mirrors
 * `LinkSummary`'s sheet shell (`bg-background px-4`) and `GifPickerSheet`'s
 * debounced search. Searches the Syra catalog proxy, auditions a result, lets
 * the owner choose the 30s start offset, and saves/removes via `updateMySettings`.
 */
export const SongPickerSheet = memo(function SongPickerSheet({
  currentSong,
  onClose,
}: SongPickerSheetProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selected, setSelected] = useState<SongSelection | null>(() => selectionFromSong(currentSong));
  const [startSec, setStartSec] = useState<number>(() => currentSong?.startSec ?? 0);
  const [saving, setSaving] = useState(false);

  // Debounce the raw input into the query key (the only effect here — React
  // Query owns the actual fetch, dedupe, and caching).
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const searchState = useQuery({
    queryKey: ['profile-song-search', debouncedQuery],
    queryFn: () => searchProfileSongs(debouncedQuery),
    enabled: debouncedQuery.length > 0,
    staleTime: 60_000,
  });
  const results = useMemo(() => searchState.data ?? [], [searchState.data]);

  const maxStartSec = useMemo(
    () => Math.max(0, Math.floor(selected?.durationSec ?? 0) - PREVIEW_WINDOW_SEC),
    [selected?.durationSec],
  );

  const handleSelect = useCallback((result: ProfileSongSearchResult) => {
    setSelected({
      syraTrackId: result.syraTrackId,
      title: result.title,
      artist: result.artist,
      artworkUrl: result.artworkUrl,
      previewUrl: result.previewUrl,
      durationSec: result.durationSec,
    });
    setStartSec(0);
  }, []);

  const decrementStart = useCallback(() => {
    setStartSec((prev) => Math.max(0, prev - START_STEP_SEC));
  }, []);

  const incrementStart = useCallback(() => {
    setStartSec((prev) => Math.min(maxStartSec, prev + START_STEP_SEC));
  }, [maxStartSec]);

  const handleSave = useCallback(async () => {
    if (!selected || saving) {
      return;
    }
    setSaving(true);
    const updated = await updateMySettings({
      profileSong: { syraTrackId: selected.syraTrackId, startSec },
    });
    setSaving(false);
    if (updated) {
      toast(t('profile.song.saved'), { type: 'success' });
      onClose();
    } else {
      const message = useAppearanceStore.getState().error;
      logger.error('Failed to save profile song', { error: message });
      toast(message || t('profile.song.saveError'), { type: 'error' });
    }
  }, [selected, saving, startSec, updateMySettings, t, onClose]);

  const handleRemove = useCallback(async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    const updated = await updateMySettings({ profileSong: null });
    setSaving(false);
    if (updated) {
      toast(t('profile.song.removed'), { type: 'success' });
      onClose();
    } else {
      const message = useAppearanceStore.getState().error;
      logger.error('Failed to remove profile song', { error: message });
      toast(message || t('profile.song.saveError'), { type: 'error' });
    }
  }, [saving, updateMySettings, t, onClose]);

  return (
    <View className="bg-background px-4 pt-3 pb-2">
      <Text className="text-foreground text-lg font-bold mb-3">
        {t('profile.song.title')}
      </Text>

      {/* Search input — mirrors GifPickerSheet's styled search row. */}
      <View className="flex-row items-center px-3 py-2.5 rounded-xl bg-secondary gap-2.5">
        <MagnifyingGlass_Stroke2_Corner0_Rounded size="sm" fill={colors.textSecondary} />
        <TextInput
          className="flex-1 text-[15px] text-foreground"
          placeholder={t('profile.song.searchPlaceholder')}
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
            accessibilityLabel={t('profile.song.clearSearch')}
            hitSlop={8}
          >
            <CircleX_Stroke2_Corner0_Rounded size="sm" fill={colors.textSecondary} />
          </Pressable>
        )}
      </View>

      {/* Results */}
      <View className="mt-2 min-h-[120px]">
        {searchState.isLoading ? (
          <View className="items-center justify-center py-10">
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        ) : searchState.isError ? (
          <Text className="text-muted-foreground text-[15px] text-center py-10">
            {t('profile.song.searchError')}
          </Text>
        ) : debouncedQuery.length === 0 ? (
          <Text className="text-muted-foreground text-[15px] text-center py-10">
            {t('profile.song.searchHint')}
          </Text>
        ) : results.length === 0 ? (
          <View className="items-center justify-center py-10 gap-2">
            <MagnifyingGlassX_Stroke2_Corner0_Rounded size="xl" fill={colors.textSecondary} />
            <Text className="text-muted-foreground text-[15px]">
              {t('profile.song.empty')}
            </Text>
          </View>
        ) : (
          <ScrollView className="max-h-[300px]" showsVerticalScrollIndicator={false}>
            {results.map((result) => (
              <SongResultRow
                key={result.syraTrackId}
                result={result}
                isSelected={selected?.syraTrackId === result.syraTrackId}
                onSelect={handleSelect}
              />
            ))}
          </ScrollView>
        )}
      </View>

      {/* Selected track — start offset + save */}
      {selected && (
        <View className="bg-secondary rounded-xl p-3 mt-2">
          <View className="flex-row items-center gap-3">
            {selected.artworkUrl ? (
              <Image
                source={{ uri: selected.artworkUrl }}
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
                {selected.title}
              </Text>
              <Text className="text-muted-foreground text-[13px]" numberOfLines={1}>
                {selected.artist}
              </Text>
            </View>
          </View>

          {maxStartSec > 0 && (
            <View className="flex-row items-center justify-between mt-3">
              <Text className="text-muted-foreground text-[13px]">
                {t('profile.song.startsAt', { time: formatStartTime(startSec) })}
              </Text>
              <View className="flex-row items-center gap-3">
                <Pressable
                  onPress={decrementStart}
                  disabled={startSec <= 0}
                  accessibilityRole="button"
                  accessibilityLabel={t('profile.song.startEarlier')}
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
                  accessibilityLabel={t('profile.song.startLater')}
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
            onPress={handleSave}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel={t('profile.song.save')}
            className="mt-3 rounded-full bg-primary py-2.5 items-center justify-center"
            style={{ opacity: saving ? 0.6 : 1 }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Text className="text-[15px] font-semibold" style={{ color: colors.primaryForeground }}>
                {t('profile.song.save')}
              </Text>
            )}
          </Pressable>
        </View>
      )}

      {/* Remove the currently pinned song */}
      {currentSong && (
        <Pressable
          onPress={handleRemove}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel={t('profile.song.remove')}
          className="flex-row items-center justify-center gap-2 mt-3 py-2.5"
        >
          <Trash_Stroke2_Corner0_Rounded size="sm" fill={colors.error} />
          <Text className="text-[15px] font-semibold" style={{ color: colors.error }}>
            {t('profile.song.remove')}
          </Text>
        </Pressable>
      )}
    </View>
  );
});
