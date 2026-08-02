import React from 'react';
import { TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { ThemedText } from './ThemedText';
import { cn } from '@/lib/utils';

interface ChannelFollowButtonProps {
  isFollowing: boolean;
  /** A follow/unfollow call for THIS channel is in flight. */
  isPending: boolean;
  onPress: () => void;
}

/**
 * THE follow pill for a channel — filled until the reader follows, outlined
 * after. Shared by the directory and the channel's own page so the control never
 * diverges between them.
 *
 * A TouchableOpacity rather than a Bloom `Button`, for the same reason
 * {@link FeedSubscribeButton} is one: it is handed to `ChannelCard`'s
 * `headerRight`, INSIDE the card's own pressable region, and only RN's responder
 * system lets the inner control win the press. A real DOM button would bubble its
 * click to the card and open the channel instead of following it.
 *
 * Not `EntityFollowButton`: that component is hard-typed to `'hashtag' | 'list'`
 * and writes through `EntityFollow`, while a channel follow is its own model
 * carrying per-follower state (`notify`) that `EntityFollow` cannot hold. The
 * two look alike and are not interchangeable.
 */
export const ChannelFollowButton = React.memo(function ChannelFollowButton({
  isFollowing,
  isPending,
  onPress,
}: ChannelFollowButtonProps) {
  const { t } = useTranslation();

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={isPending}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityState={{ selected: isFollowing, busy: isPending }}
      className={cn(
        'min-w-[88px] items-center justify-center rounded-full border px-3.5 py-[7px]',
        isFollowing ? 'border-border bg-transparent' : 'bg-primary border-transparent',
      )}>
      {isPending ? (
        <SpinnerIcon
          size={16}
          className={isFollowing ? 'text-foreground' : 'text-primary-foreground'}
        />
      ) : (
        <ThemedText
          className={cn(
            'text-[13px] font-bold',
            isFollowing ? 'text-foreground' : 'text-primary-foreground',
          )}>
          {isFollowing
            ? t('channels.following', { defaultValue: 'Following' })
            : t('channels.follow', { defaultValue: 'Follow' })}
        </ThemedText>
      )}
    </TouchableOpacity>
  );
});
