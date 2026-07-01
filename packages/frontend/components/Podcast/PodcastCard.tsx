import React, { memo, useCallback } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import {
  Pencil_Stroke2_Corner0_Rounded,
  SpeakerVolumeFull_Stroke2_Corner0_Rounded,
  SquareArrowTopRight_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';
import { cn } from '@/lib/utils';
import { openExternalLink } from '@/utils/openExternalLink';

export type PodcastCardVariant = 'full' | 'card';

interface PodcastCardProps {
  title: string;
  author?: string;
  artworkUrl?: string;
  /**
   * Opens the show in Syra on tap. Present for rendered posts and pinned profile
   * media (denormalized server-side). The compose attachment has no show URL yet,
   * so it omits this and supplies `onPress` to re-open the picker instead.
   */
  showUrl?: string;
  /**
   * `'full'` — the full-width profile card (square artwork + title + PODCAST +
   * author). `'card'` — a 280px carousel card sharing the link attachment card's
   * container chrome (border + bg-secondary + rounded-[14px]) so it reads as one
   * family in the feed (compose + feed).
   */
  variant?: PodcastCardVariant;
  /** Overrides the default tap behavior (open show). Compose passes the picker opener. */
  onPress?: () => void;
  /** Owner edit affordance (full variant only) — pencil tap + long-press. */
  onEdit?: () => void;
  isOwnProfile?: boolean;
  className?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Shared, router-agnostic podcast show card. A single Pressable that opens the
 * show in Syra (`showUrl`) — or runs an `onPress` override — across three
 * surfaces: the full-width profile card (`variant="full"`), the compact compose
 * attachment, and the rendered-post attachment (both `variant="card"`). No audio
 * preview, by design.
 */
export const PodcastCard = memo(function PodcastCard({
  title,
  author,
  artworkUrl,
  showUrl,
  variant = 'card',
  onPress,
  onEdit,
  isOwnProfile = false,
  className,
  style,
}: PodcastCardProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const openShow = useCallback(() => {
    if (!showUrl) return;
    openExternalLink(showUrl);
  }, [showUrl]);

  const handlePress = onPress ?? (showUrl ? openShow : undefined);

  const label = (
    <View className="flex-row items-center gap-1.5 mt-0.5">
      <Text className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
        {t('profile.media.podcastLabel')}
      </Text>
      {author ? (
        <>
          <Text className="text-muted-foreground text-[11px]">·</Text>
          <Text className="text-muted-foreground text-[13px] shrink" numberOfLines={1}>
            {author}
          </Text>
        </>
      ) : null}
    </View>
  );

  if (variant === 'full') {
    return (
      <Pressable
        className={cn('flex-row items-center gap-3 mb-3 rounded-2xl bg-secondary p-3', className)}
        style={style}
        onPress={handlePress}
        onLongPress={isOwnProfile ? onEdit : undefined}
        accessibilityRole="button"
        accessibilityLabel={t('profile.media.openInSyra')}
      >
        {artworkUrl ? (
          <Image
            source={{ uri: artworkUrl }}
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
            {title}
          </Text>
          {label}
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
  }

  return (
    <Pressable
      className={cn(
        'w-[280px] flex-row items-center gap-3 border border-border bg-secondary rounded-[14px] overflow-hidden p-3',
        className,
      )}
      style={style}
      onPress={handlePress}
      disabled={!handlePress}
      accessibilityRole="button"
      accessibilityLabel={t('profile.media.openInSyra')}
    >
      {artworkUrl ? (
        <Image
          source={{ uri: artworkUrl }}
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
          {title}
        </Text>
        {label}
      </View>
    </Pressable>
  );
});
