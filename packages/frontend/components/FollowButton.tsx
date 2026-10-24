import type { ComponentProps } from 'react';
import type { BulkFollowResult, BulkUnfollowResult } from '@oxy.so/core';
import { FollowButton as OxyFollowButton, useAuth, useAuthStore } from '@oxy.so/services/ui/client';
import { notifyFeedRankingChanged } from '@/stores/feedRankingInvalidation';

/** Keep Mention's feed evidence in step with accepted SDK graph mutations. */
export function FollowButton(props: ComponentProps<typeof OxyFollowButton>) {
  const { user } = useAuth();
  const viewerId = user?.id;
  const isCurrentViewer = () => !!viewerId && useAuthStore.getState().user?.id === viewerId;
  const notify = () => {
    // A late success still invalidates its owner, never the newly selected account.
    if (viewerId) notifyFeedRankingChanged(viewerId);
  };

  if (props.userIds) {
    return (
      <OxyFollowButton
        {...props}
        onFollowChange={(following) => {
          if (isCurrentViewer()) props.onFollowChange?.(following);
        }}
        onBulkFollow={(result: BulkFollowResult) => {
          if (result.followedCount > 0) notify();
          if (isCurrentViewer()) props.onBulkFollow?.(result);
        }}
        onBulkUnfollow={(result: BulkUnfollowResult) => {
          if (result.unfollowedCount > 0) notify();
          if (isCurrentViewer()) props.onBulkUnfollow?.(result);
        }}
      />
    );
  }

  return (
    <OxyFollowButton
      {...props}
      onFollowChange={(following) => {
        // The SDK invokes this only after a successful single-user mutation.
        notify();
        if (isCurrentViewer()) props.onFollowChange?.(following);
      }}
    />
  );
}
