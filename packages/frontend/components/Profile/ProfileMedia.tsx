import React, { memo, useCallback, useContext } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { PlusLarge_Stroke2_Corner0_Rounded } from '@oxyhq/bloom/icons';
import type { ProfileMedia as ProfileMediaData } from '@/store/appearanceStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { ProfileSong } from './ProfileSong';
import { PodcastCard } from '@/components/Podcast/PodcastCard';
import { MediaPickerSheet } from './MediaPickerSheet';

interface ProfileMediaProps {
  media: ProfileMediaData | null;
  isOwnProfile: boolean;
}

/**
 * Dispatcher for a profile's pinned media (song XOR podcast). Renders the
 * compact song row for `type === 'song'`, the Threads-style card for
 * `type === 'podcast'`, an "Add song or podcast" entry when nothing is set (owner
 * only), and nothing for other viewers. Owns the shared picker-open callback so
 * the add entry, the song edit affordance, and the podcast edit affordance all
 * open the same `MediaPickerSheet`.
 *
 * `ProfileContent` gates WHERE this mounts (the song/add entry after the stats,
 * the podcast card at the bottom of the header), so this component only ever
 * renders its single matching branch.
 */
export const ProfileMedia = memo(function ProfileMedia({ media, isOwnProfile }: ProfileMediaProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const bottomSheet = useContext(BottomSheetContext);

  const openPicker = useCallback(() => {
    bottomSheet.setBottomSheetContent(
      <MediaPickerSheet
        currentMedia={media}
        onClose={() => bottomSheet.openBottomSheet(false)}
      />,
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, media]);

  if (!media) {
    // No media: owners get an "Add song or podcast" entry; other viewers see nothing.
    if (!isOwnProfile) {
      return null;
    }
    return (
      <Pressable
        className="flex-row items-center gap-2 mb-3"
        onPress={openPicker}
        accessibilityRole="button"
        accessibilityLabel={t('profile.media.add')}
      >
        <View
          className="rounded-full bg-secondary items-center justify-center"
          style={{ width: 32, height: 32 }}
        >
          <PlusLarge_Stroke2_Corner0_Rounded size="sm" fill={colors.primary} />
        </View>
        <Text className="text-primary text-[15px]">{t('profile.media.add')}</Text>
      </Pressable>
    );
  }

  if (media.type === 'song') {
    return <ProfileSong song={media} isOwnProfile={isOwnProfile} onEdit={openPicker} />;
  }

  return (
    <PodcastCard
      variant="full"
      title={media.title}
      author={media.author}
      artworkUrl={media.artworkUrl}
      showUrl={media.showUrl}
      isOwnProfile={isOwnProfile}
      onEdit={openPicker}
    />
  );
});
