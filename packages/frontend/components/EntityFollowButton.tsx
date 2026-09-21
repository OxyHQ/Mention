import React, { memo } from 'react';
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
  entityType, entityId, label, followingLabel, size = 'md',
}: EntityFollowButtonProps) {
  const { isFollowing, isLoading, toggle } = useFollowEntity(entityType, entityId);
  const { t } = useTranslation();
  return (
    <FollowButton
      following={isFollowing}
      onFollowChange={() => { void toggle(); }}
      disabled={isLoading}
      loading={isLoading}
      size={size === 'sm' ? 'small' : 'medium'}
      label={label || t('common.follow', { defaultValue: 'Follow' })}
      followingLabel={followingLabel || t('common.following', { defaultValue: 'Following' })}
    />
  );
});

export default EntityFollowButton;
