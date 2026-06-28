import React, { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import {
  MusicNote_Stroke2_Corner0_Rounded,
  Pencil_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';
import type { ProfileSongMedia } from '@/store/appearanceStore';
import { useProfileSongPreview } from '@/hooks/useProfileSongPreview';
import { SongPreviewButton } from './SongPreviewButton';

interface ProfileSongProps {
  song: ProfileSongMedia;
  isOwnProfile: boolean;
  /** Opens the media picker (owner only) — wired from the `ProfileMedia` dispatcher. */
  onEdit: () => void;
}

/**
 * Instagram-style profile song — the SONG branch of `ProfileMedia`. Renders a
 * compact row (a play/pause circle, the track artwork, and "Title · Artist" on
 * one line) that auditions a 30s preview when tapped. Owners can open the picker
 * (long-press the row or tap the edit affordance). Placed right after the profile
 * stats. Mirrors `LinkSummary`'s compact-row shape.
 */
export const ProfileSong = memo(function ProfileSong({ song, isOwnProfile, onEdit }: ProfileSongProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const preview = useProfileSongPreview(song.previewUrl);

  return (
    <View className="flex-row items-center gap-2 mb-3">
      <SongPreviewButton
        isPlaying={preview.isPlaying}
        isLoading={preview.isLoading}
        onPress={preview.toggle}
        accessibilityLabel={preview.isPlaying ? t('profile.media.song.pause') : t('profile.media.song.play')}
      />
      <Pressable
        className="flex-row items-center gap-2 shrink"
        onPress={preview.toggle}
        onLongPress={isOwnProfile ? onEdit : undefined}
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
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel={t('profile.media.edit')}
          hitSlop={8}
          className="p-1"
        >
          <Pencil_Stroke2_Corner0_Rounded size="sm" fill={colors.textSecondary} />
        </Pressable>
      )}
    </View>
  );
});
