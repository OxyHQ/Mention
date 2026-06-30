import React, { useMemo } from 'react';
import Feed from '@/components/Feed/Feed';
import { TrendsWidget } from '@/components/widgets/TrendsWidget';

/**
 * Explore › All — the default tab (route `/explore`). The "What's trending" strip
 * rides above the ranked explore feed as the feed's scroll-away header (memoized
 * for a stable element identity so the Feed doesn't re-render on every parent render).
 */
export default function ExploreAllScreen() {
  const trendsHeader = useMemo(() => <TrendsWidget variant="inline" />, []);
  return <Feed type="explore" listHeaderComponent={trendsHeader} />;
}
