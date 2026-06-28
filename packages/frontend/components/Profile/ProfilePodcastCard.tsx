import React, { memo, useCallback } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import {
  Pencil_Stroke2_Corner0_Rounded,
  SpeakerVolumeFull_Stroke2_Corner0_Rounded,
  SquareArrowTopRight_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';
import { createScopedLogger } from '@/lib/logger';
import type { ProfilePodcastMedia } from '@/store/appearanceStore';

const logger = createScopedLogger('ProfilePodcastCard');

interface ProfilePodcastCardProps {
  podcast: ProfilePodcastMedia;
  isOwnProfile: boolean;
  /** Opens the media picker (owner only) — wired from the `ProfileMedia` dispatcher. */
  onEdit: () => void;
}

/**
 * Threads-style profile podcast — the PODCAST branch of `ProfileMedia`. A
 * full-width rounded card (square artwork + title, a "PODCAST" label and the show
 * author) that opens the show in Syra when tapped. Placed at the bottom of the
 * profile header. No audio preview (unlike the song row). Owners can long-press or
 * tap the edit affordance to open the picker.
 */
export const ProfilePodcastCard = memo(function ProfilePodcastCard({
  podcast,
  isOwnProfile,
  onEdit,
}: ProfilePodcastCardProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const openShow = useCallback(() => {
    Linking.openURL(podcast.showUrl).catch((error: unknown) => {
      logger.warn('Failed to open podcast show URL', { error });
    });
  }, [podcast.showUrl]);

  return (
    <Pressable
      className="flex-row items-center gap-3 mb-3 rounded-2xl bg-secondary p-3"
      onPress={openShow}
      onLongPress={isOwnProfile ? onEdit : undefined}
      accessibilityRole="button"
      accessibilityLabel={t('profile.media.openInSyra')}
    >
      {podcast.artworkUrl ? (
        <Image
          source={{ uri: podcast.artworkUrl }}
          style={{ width: 56, height: 56, borderRadius: 12 }}
          contentFit="cover"
          transition={120}
        />
      ) : (
        <View
          className="rounded-xl bg-background items-center justify-center"
          style={{ width: 56, height: 56 }}
        >
          <SpeakerVolumeFull_Stroke2_Corner0_Rounded size="lg" fill={colors.textSecondary} />
        </View>
      )}

      <View className="flex-1 shrink">
        <Text className="text-foreground text-[15px] font-bold" numberOfLines={2}>
          {podcast.title}
        </Text>
        <View className="flex-row items-center gap-1.5 mt-0.5">
          <Text className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
            {t('profile.media.podcastLabel')}
          </Text>
          {podcast.author ? (
            <>
              <Text className="text-muted-foreground text-[11px]">·</Text>
              <Text className="text-muted-foreground text-[13px] shrink" numberOfLines={1}>
                {podcast.author}
              </Text>
            </>
          ) : null}
        </View>
      </View>

      {isOwnProfile ? (
        <Pressable
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel={t('profile.media.edit')}
          hitSlop={8}
          className="p-1"
        >
          <Pencil_Stroke2_Corner0_Rounded size="sm" fill={colors.textSecondary} />
        </Pressable>
      ) : (
        <SquareArrowTopRight_Stroke2_Corner0_Rounded size="sm" fill={colors.textSecondary} />
      )}
    </Pressable>
  );
});
