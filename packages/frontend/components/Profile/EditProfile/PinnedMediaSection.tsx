import type React from 'react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { useAppearanceStore } from '@/stores/appearanceStore';
import { ProfileSong } from '../ProfileSong';
import { PodcastCard } from '@/components/Podcast/PodcastCard';
import { openProfileMediaPicker } from '../openProfileMediaPicker';
import { Embed, HStack, Icon, RawText, VStack, toElement } from '@oxy.so/bloom-language';

/**
 * Pinned song/podcast editor for the Edit Profile screen. Unlike
 * `ProfileMedia` (the read-only public-profile display, which hides entirely
 * when nothing is pinned), this section always shows either the current pick
 * or an "Add" affordance — it only ever renders on a screen the owner alone
 * can reach.
 */
export const PinnedMediaSection: React.FC = () => {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const media = useAppearanceStore((state) => state.mySettings?.profileMedia ?? null);

  const openPicker = useCallback(() => {
    openProfileMediaPicker(media);
  }, [media]);

  if (!media) {
    return toElement(
      VStack(
        HStack(
          VStack(Icon(RiAddLine).size('sm').foreground('primary'))
            .frame({ width: '3xl', height: '3xl' })
            .background('mutedFill')
            .corner('infinite')
            .align('center')
            .justify('center'),
          RawText(t('profile.media.add')).foreground('primary').font('md'),
        )
          .align('center')
          .spacing('sm')
          .onPress(openPicker)
          .role('button')
          .label(t('profile.media.add')),
      )
        .padding('horizontal', 'xl')
        .padding('vertical', 'md'),
    );
  }

  return toElement(
    VStack(
      Embed(
        media.type === 'song' ? (
          <ProfileSong song={media} isOwnProfile onEdit={openPicker} />
        ) : (
          <PodcastCard
            variant="full"
            title={media.title}
            author={media.author}
            artworkUrl={media.artworkUrl}
            showUrl={media.showUrl}
            isOwnProfile
            onEdit={openPicker}
          />
        ),
      ),
    )
      .padding('horizontal', 'xl')
      .padding('vertical', 'md'),
  );
};
