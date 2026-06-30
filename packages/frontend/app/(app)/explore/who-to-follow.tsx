import React from 'react';
import { WhoToFollowTab } from '@/components/WhoToFollowTab';

/**
 * Explore › Who to follow (route `/explore/who-to-follow`) — recommended accounts
 * for the viewer to follow, backed by the shared `useRecommendations` cache.
 */
export default function ExploreWhoToFollowScreen() {
  return <WhoToFollowTab />;
}
