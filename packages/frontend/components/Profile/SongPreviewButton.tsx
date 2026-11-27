import { memo } from 'react';
import { RiPauseFill } from '@oxy.so/bloom/icons/RiPauseFill';
import { RiPlayFill } from '@oxy.so/bloom/icons/RiPlayFill';
import { Icon, VStack, toElement } from '@oxy.so/bloom-language';
import { SpinnerIcon } from '@oxy.so/bloom-language/spinner-icon';

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
  const side = size === 'sm' ? '3xl' : '36';
  const PlaybackIcon = isPlaying ? RiPauseFill : RiPlayFill;

  return toElement(
    VStack(
      isLoading
        ? SpinnerIcon().size('md').tint('onPrimary')
        : Icon(PlaybackIcon).size('sm').foreground('onPrimary'),
    )
      .frame({ width: side, height: side })
      .background('primary')
      .corner('infinite')
      .align('center')
      .justify('center')
      .onPress(onPress)
      .role('button')
      .label(accessibilityLabel)
      .hitSlop('sm'),
  );
});
