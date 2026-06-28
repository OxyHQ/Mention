import React, { memo } from 'react';
import { ActivityIndicator, Pressable } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import {
  Play_Stroke2_Corner0_Rounded,
  Pause_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';

interface SongPreviewButtonProps {
  isPlaying: boolean;
  isLoading: boolean;
  onPress: () => void;
  /** Diameter preset: `sm` (32) for list rows, `md` (36) for the profile row. */
  size?: 'sm' | 'md';
  accessibilityLabel: string;
}

/**
 * Presentational play/pause circle for a profile-song preview. Stateless — the
 * owning component drives it from `useProfileSongPreview`. Shared by the profile
 * row (`ProfileSong`) and the picker result rows (`SongPickerSheet`).
 */
export const SongPreviewButton = memo(function SongPreviewButton({
  isPlaying,
  isLoading,
  onPress,
  size = 'md',
  accessibilityLabel,
}: SongPreviewButtonProps) {
  const { colors } = useTheme();
  const dimension = size === 'sm' ? 32 : 36;
  const Icon = isPlaying ? Pause_Stroke2_Corner0_Rounded : Play_Stroke2_Corner0_Rounded;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={6}
      className="rounded-full bg-primary items-center justify-center"
      style={{ width: dimension, height: dimension }}
    >
      {isLoading ? (
        <ActivityIndicator size="small" color={colors.primaryForeground} />
      ) : (
        <Icon size="sm" fill={colors.primaryForeground} />
      )}
    </Pressable>
  );
});
