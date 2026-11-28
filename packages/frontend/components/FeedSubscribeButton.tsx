// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
  isSubscribed,
  isSubscribing,
  onPress,
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
