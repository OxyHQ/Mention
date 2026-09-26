import React, { memo } from 'react';
import { Pressable } from 'react-native';
import { SpinnerIcon } from '@oxy.so/bloom/loading';
import { RiPauseFill } from '@oxy.so/bloom/icons/RiPauseFill';
import { RiPlayFill } from '@oxy.so/bloom/icons/RiPlayFill';
import { useTheme } from '@oxy.so/bloom/theme';
import { HIT_SLOP_SM } from '@/styles/hitSlop';

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
 * song row (`ProfileSong`) and the picker song result rows (`MediaPickerSheet`).
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
  const PlaybackIcon = isPlaying ? RiPauseFill : RiPlayFill;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={HIT_SLOP_SM}
      className="rounded-full bg-primary items-center justify-center"
      style={{ width: dimension, height: dimension }}
    >
      {isLoading ? (
        <SpinnerIcon size={20} color={colors.primaryForeground} />
      ) : (
        <PlaybackIcon size="sm" fill={colors.primaryForeground} />
      )}
    </Pressable>
  );
});
