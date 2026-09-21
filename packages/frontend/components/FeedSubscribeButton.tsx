import React from 'react';
import { useTranslation } from 'react-i18next';
import { FollowButton } from '@oxy.so/bloom/media-header';

interface FeedSubscribeButtonProps {
  isSubscribed: boolean;
  isSubscribing: boolean;
  onPress: () => void;
}

/** Feed subscription state bound to Bloom's shared animated toggle. */
export const FeedSubscribeButton = React.memo(function FeedSubscribeButton({
  isSubscribed, isSubscribing, onPress,
}: FeedSubscribeButtonProps) {
  const { t } = useTranslation();
  return (
    <FollowButton
      following={isSubscribed}
      loading={isSubscribing}
      disabled={isSubscribing}
      onFollowChange={onPress}
      label={t('feeds.subscribe')}
      followingLabel={t('feeds.subscribed')}
    />
  );
});
