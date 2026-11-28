// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { memo } from 'react';
import { FollowButton } from '@oxy.so/bloom/media-header';
import { useFollowEntity } from '@/hooks/useFollowEntity';
import type { EntityFollowType } from '@/services/entityFollowService';
import { useTranslation } from 'react-i18next';

interface EntityFollowButtonProps {
  /**
   * Only the entity kinds `/entity-follows` actually serves. A custom feed is
   * not one of them — subscribe to a feed with `FeedSubscribeButton`, which
   * writes the `FeedLike` row the rest of the app reads.
   */
  entityType: EntityFollowType;
  entityId: string;
  label?: string;
  followingLabel?: string;
  size?: 'sm' | 'md';
}

export const EntityFollowButton = memo(function EntityFollowButton({
  entityType,
  entityId,
  label,
  followingLabel,
  size = 'md',
}: EntityFollowButtonProps) {
  const { isFollowing, isLoading, toggle } = useFollowEntity(entityType, entityId);
  const { t } = useTranslation();
  return (
    <FollowButton
      following={isFollowing}
      onFollowChange={() => {
        void toggle();
      }}
      disabled={isLoading}
      loading={isLoading}
      size={size}
      label={label || t('common.follow', { defaultValue: 'Follow' })}
      followingLabel={followingLabel || t('common.following', { defaultValue: 'Following' })}
    />
  );
});

export default EntityFollowButton;
