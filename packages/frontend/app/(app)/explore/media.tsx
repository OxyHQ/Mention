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
 * Explore › Media (route `/explore/media`) — the media-only explore feed with the
 * same scroll-away trending strip as the All tab.
 */
export default function ExploreMediaScreen() {
  const trendsHeader = useMemo(() => <TrendsWidget variant="inline" />, []);
  const reloadKey = useReselectReloadKey();
  return <Feed type="media" listHeaderComponent={trendsHeader} reloadKey={reloadKey} />;
}
