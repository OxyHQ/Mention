import { memo } from 'react';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiMusic2Line } from '@oxy.so/bloom/icons/RiMusic2Line';
import type { ProfileSongMedia } from '@/stores/appearanceStore';
import { useProfileSongPreview } from '@/hooks/useProfileSongPreview';
import { SongPreviewButton } from './SongPreviewButton';

import { Embed, HStack, Icon, RawText, VStack, toElement } from '@oxy.so/bloom-language';

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
 * stats. Mirrors `ProfileLinkChips`' compact-row shape.
 */
export const ProfileSong = memo(function ProfileSong({
  song,
  isOwnProfile,
  onEdit,
}: ProfileSongProps) {
  const { t } = useTranslation();
  const preview = useProfileSongPreview(song.previewUrl);

  return toElement(
    HStack(
      Embed(
        <SongPreviewButton
          isPlaying={preview.isPlaying}
          isLoading={preview.isLoading}
          onPress={preview.toggle}
          accessibilityLabel={
            preview.isPlaying ? t('profile.media.song.pause') : t('profile.media.song.play')
          }
        />,
      ),
      HStack(
        song.artworkUrl
          ? Embed(
              <Image
                source={{ uri: song.artworkUrl }}
                style={{ width: 32, height: 32, borderRadius: 6 }}
                contentFit="cover"
                transition={120}
              />,
            )
          : VStack(Icon(RiMusic2Line).size('sm').foreground('muted'))
              .frame({ width: '3xl', height: '3xl' })
              .background('mutedFill')
              // Rounded on the web only: the app's `rounded-md` reads `--radius`, which native never had.
              .when('web', (v) => v.corner('14'))
              .align('center')
              .justify('center'),
        RawText(
          RawText(song.title).weight('semibold'),
          '  ·  ',
          RawText(song.artist).foreground('muted'),
        )
          .foreground('foreground')
          .font('md')
          .shrink('normal')
          .lines(1),
      )
        .align('center')
        .spacing('sm')
        .shrink('normal')
        .onPress(preview.toggle)
        .onLongPress(isOwnProfile ? onEdit : undefined)
        .role('button')
        .label(`${song.title} · ${song.artist}`),
      isOwnProfile
        ? VStack(Icon(RiEditLine).size('sm').foreground('muted'))
            .padding('all', 'xs')
            .onPress(onEdit)
            .role('button')
            .label(t('profile.media.edit'))
            .hitSlop('md')
        : null,
    )
      .align('center')
      .spacing('sm')
      .margin('bottom', 'md'),
  );
});
