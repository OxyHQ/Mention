import React, { useMemo } from 'react';
import Feed from '@/components/Feed/Feed';
import { useReselectReloadKey } from '@/context/ScreenReselectContext';
import { TrendsWidget } from '@/components/widgets/TrendsWidget';

/**
 * Explore › Media (route `/explore/media`) — the media-only explore feed with the
 * same scroll-away trending strip as the All tab.
 */
export default function ExploreMediaScreen() {
  const trendsHeader = useMemo(() => <TrendsWidget variant="inline" />, []);
  const reloadKey = useReselectReloadKey();
  return <Feed type="media" listHeaderComponent={trendsHeader} reloadKey={reloadKey} />;
}
