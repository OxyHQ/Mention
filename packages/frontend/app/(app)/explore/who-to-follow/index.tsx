import { LazyWhoToFollowTab } from '@/components/sharedRouteScreens';

/**
 * Explore › Who to follow (route `/explore/who-to-follow`) — recommended accounts
 * for the viewer to follow, backed by the shared `useRecommendations` cache.
 */
export default function ExploreWhoToFollowScreen() {
  return <LazyWhoToFollowTab />;
}
