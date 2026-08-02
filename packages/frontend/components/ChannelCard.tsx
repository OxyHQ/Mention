import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { router } from 'expo-router';
import { Avatar } from '@oxyhq/bloom/avatar';
import { useTranslation } from 'react-i18next';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import type { Channel } from '@mention/shared-types';
import { ThemedText } from './ThemedText';
import { formatCompactNumber } from '@/utils/formatNumber';

interface ChannelCardProps {
  channel: Channel;
  /** Overrides the default navigation to the channel's own page. */
  onPress?: () => void;
  /** Right-hand slot — the follow pill, or an invitation's accept/decline pair. */
  headerRight?: React.ReactNode;
  showDescription?: boolean;
}

/** Flush full-width row — the shape `FeedCard`'s `row` variant draws. */
const OUTER_CLASS = 'w-full px-3 py-3 gap-1 border-b border-border';

/**
 * One channel in a list — the same layout `FeedCard` gives a custom feed, so the
 * two read as the same kind of thing on the screens that show both.
 *
 * The avatar is a bare Oxy file id handed straight to Bloom's `Avatar`, which
 * resolves it through the app-wide `ImageResolver`. Never a URL: `Channel.avatar`
 * is an id by contract, and pre-resolving it here would be a second media path.
 *
 * `headerRight` sits INSIDE this card's pressable region, so whatever goes there
 * has to be a control RN's responder system lets win the press — see
 * {@link ChannelFollowButton}.
 */
export function ChannelCard({
  channel,
  onPress,
  headerRight,
  showDescription = true,
}: ChannelCardProps) {
  const { t } = useTranslation();

  const handlePress = useCallback(() => {
    if (onPress) {
      onPress();
      return;
    }
    // The readable spelling in the URL; the feed descriptor keeps the id, so a
    // rename costs a link and never a pinned tab.
    router.push(`/c/${channel.handle}`);
  }, [onPress, channel.handle]);

  const statsLine = useMemo(() => {
    const parts = [
      t('channels.followerCount', {
        count: channel.followerCount,
        defaultValue: '{{count}} followers',
      }),
      t('channels.postCount', {
        count: channel.postCount,
        defaultValue: '{{count}} posts',
      }),
    ];
    return parts.join(' · ');
  }, [channel.followerCount, channel.postCount, t]);

  const accessibilityLabel = useMemo(
    () =>
      [
        channel.title,
        `@${channel.handle}`,
        formatCompactNumber(channel.followerCount),
        t('channels.followersWord', { defaultValue: 'followers' }),
      ].join(', '),
    [channel.title, channel.handle, channel.followerCount, t],
  );

  return (
    <PressableScale
      onPress={handlePress}
      className={OUTER_CLASS}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={`channel-${channel.id}`}>
      <View className="flex-row items-center gap-3">
        <Avatar
          source={channel.avatar}
          size={36}
          variant={MEDIA_VARIANT_AVATAR}
          shape="squircle"
        />

        <View className="flex-1">
          <ThemedText className="text-sm font-semibold leading-[18px]" numberOfLines={1}>
            {channel.title}
          </ThemedText>
          <ThemedText
            className="text-sm text-muted-foreground leading-[18px]"
            numberOfLines={1}>
            {`@${channel.handle}`}
          </ThemedText>
        </View>

        {headerRight ? <View>{headerRight}</View> : null}
      </View>

      {showDescription && channel.description ? (
        <ThemedText className="text-muted-foreground text-sm leading-5" numberOfLines={2}>
          {channel.description}
        </ThemedText>
      ) : null}

      <ThemedText className="text-sm text-muted-foreground leading-[18px]" numberOfLines={1}>
        {statsLine}
      </ThemedText>
    </PressableScale>
  );
}
