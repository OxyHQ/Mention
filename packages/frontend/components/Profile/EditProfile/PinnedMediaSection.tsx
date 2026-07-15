import React, { useCallback, useContext } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { PlusLarge_Stroke2_Corner0_Rounded } from '@oxyhq/bloom/icons';
import { useAppearanceStore } from '@/store/appearanceStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { ProfileSong } from '../ProfileSong';
import { PodcastCard } from '@/components/Podcast/PodcastCard';
import { MediaPickerSheet } from '../MediaPickerSheet';

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
    return (
      <View className="px-5 py-3">
        <Pressable
          className="flex-row items-center gap-2"
          onPress={openPicker}
          accessibilityRole="button"
          accessibilityLabel={t('profile.media.add')}
        >
          <View className="w-8 h-8 rounded-full bg-secondary items-center justify-center">
            <PlusLarge_Stroke2_Corner0_Rounded size="sm" fill={colors.primary} />
          </View>
          <Text className="text-primary text-[15px]">{t('profile.media.add')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="px-5 py-3">
      {media.type === 'song' ? (
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
      )}
    </View>
  );
};
