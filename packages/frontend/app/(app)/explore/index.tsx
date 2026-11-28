// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useMemo } from 'react';
import Feed from '@/components/Feed/Feed';
import { useReselectReloadKey } from '@/hooks/useReselectReloadKey';
import { TrendsWidget } from '@/components/widgets/TrendsWidget';

/**
 * Explore › All — the default tab (route `/explore`). The "What's trending" strip
 * rides above the ranked explore feed as the feed's scroll-away header (memoized
 * for a stable element identity so the Feed doesn't re-render on every parent render).
 */
export default function ExploreAllScreen() {
  const trendsHeader = useMemo(() => <TrendsWidget variant="inline" />, []);
  const reloadKey = useReselectReloadKey();
  return <Feed type="explore" listHeaderComponent={trendsHeader} reloadKey={reloadKey} />;
}
