import React, { memo, useCallback, useContext } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import {
  MusicNote_Stroke2_Corner0_Rounded,
  Pencil_Stroke2_Corner0_Rounded,
  PlusLarge_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';
import type { ProfileSong as ProfileSongData } from '@/store/appearanceStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { useProfileSongPreview } from '@/hooks/useProfileSongPreview';
import { SongPreviewButton } from './SongPreviewButton';
import { SongPickerSheet } from './SongPickerSheet';

interface ProfileSongProps {
  song?: ProfileSongData | null;
  isOwnProfile: boolean;
}

/**
 * Instagram-style profile song. Renders a compact row — a play/pause circle, the
 * track artwork, and "Title · Artist" on one line — that auditions a 30s preview
 * when tapped. Owners can open the picker (long-press the row or tap the edit
 * affordance); when no song is set, owners see an "Add a song" entry and other
 * viewers see nothing. Mirrors `LinkSummary`'s compact-row + bottom-sheet shape.
 */
export const ProfileSong = memo(function ProfileSong({ song, isOwnProfile }: ProfileSongProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const bottomSheet = useContext(BottomSheetContext);
  const preview = useProfileSongPreview(song?.previewUrl);

  const openPicker = useCallback(() => {
    bottomSheet.setBottomSheetContent(
      <SongPickerSheet
        currentSong={song ?? null}
        onClose={() => bottomSheet.openBottomSheet(false)}
      />,
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, song]);

  if (!song) {
    // No song: owners get an "Add a song" entry; other viewers see nothing.
    if (!isOwnProfile) {
      return null;
    }
    return (
      <Pressable
        className="flex-row items-center gap-2 mb-3"
        onPress={openPicker}
        accessibilityRole="button"
        accessibilityLabel={t('profile.song.add')}
      >
        <View
          className="rounded-full bg-secondary items-center justify-center"
          style={{ width: 32, height: 32 }}
        >
          <PlusLarge_Stroke2_Corner0_Rounded size="sm" fill={colors.primary} />
        </View>
        <Text className="text-primary text-[15px]">{t('profile.song.add')}</Text>
      </Pressable>
    );
  }

  return (
    <View className="flex-row items-center gap-2 mb-3">
      <SongPreviewButton
        isPlaying={preview.isPlaying}
        isLoading={preview.isLoading}
        onPress={preview.toggle}
        accessibilityLabel={preview.isPlaying ? t('profile.song.pause') : t('profile.song.play')}
      />
      <Pressable
        className="flex-row items-center gap-2 shrink"
        onPress={preview.toggle}
        onLongPress={isOwnProfile ? openPicker : undefined}
        accessibilityRole="button"
        accessibilityLabel={`${song.title} · ${song.artist}`}
      >
        {song.artworkUrl ? (
          <Image
            source={{ uri: song.artworkUrl }}
            style={{ width: 32, height: 32, borderRadius: 6 }}
            contentFit="cover"
            transition={120}
          />
        ) : (
          <View
            className="rounded-md bg-secondary items-center justify-center"
            style={{ width: 32, height: 32 }}
          >
            <MusicNote_Stroke2_Corner0_Rounded size="sm" fill={colors.textSecondary} />
          </View>
        )}
        <Text className="text-foreground text-[15px] shrink" numberOfLines={1}>
          <Text className="font-semibold">{song.title}</Text>
          {'  ·  '}
          <Text className="text-muted-foreground">{song.artist}</Text>
        </Text>
      </Pressable>
      {isOwnProfile && (
        <Pressable
          onPress={openPicker}
          accessibilityRole="button"
          accessibilityLabel={t('profile.song.edit')}
          hitSlop={8}
          className="p-1"
        >
          <Pencil_Stroke2_Corner0_Rounded size="sm" fill={colors.textSecondary} />
        </Pressable>
      )}
    </View>
  );
});
