import React from 'react';
import { TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { ThemedText } from './ThemedText';
import { cn } from '@/lib/utils';

interface FeedSubscribeButtonProps {
  isSubscribed: boolean;
  /** A subscribe/unsubscribe call for THIS feed is in flight. */
  isSubscribing: boolean;
  onPress: () => void;
}

/**
 * THE subscribe pill for a custom feed — a filled call-to-action until the
 * viewer subscribes, an outlined "Subscribed" state after. Shared by every
 * surface that offers a feed to subscribe to (the marketplace, the feed
 * suggestions band), so the control never diverges between them.
 *
 * A TouchableOpacity rather than a Bloom `Button`: it is handed to `FeedCard`'s
 * `headerRight`, INSIDE the card's pressable region, and only RN's responder
 * system lets the inner control win the press. A real DOM button would bubble
 * its click to the card and navigate to the feed instead of subscribing.
 */
export const FeedSubscribeButton = React.memo(function FeedSubscribeButton({
  isSubscribed,
  isSubscribing,
  onPress,
}: FeedSubscribeButtonProps) {
  const { t } = useTranslation();

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={isSubscribing}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityState={{ selected: isSubscribed, busy: isSubscribing }}
      className={cn(
        'min-w-[88px] items-center justify-center rounded-full border px-3.5 py-[7px]',
        isSubscribed ? 'border-border bg-transparent' : 'bg-primary border-transparent',
      )}>
      {isSubscribing ? (
        <SpinnerIcon
          size={16}
          className={isSubscribed ? 'text-foreground' : 'text-primary-foreground'}
        />
      ) : (
        <ThemedText
          className={cn(
            'text-[13px] font-bold',
            isSubscribed ? 'text-foreground' : 'text-primary-foreground',
          )}>
          {isSubscribed ? t('feeds.subscribed') : t('feeds.subscribe')}
        </ThemedText>
      )}
    </TouchableOpacity>
  );
});
