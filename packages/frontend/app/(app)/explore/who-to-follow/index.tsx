// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { LazyWhoToFollowTab } from '@/components/sharedRouteScreens';

/**
 * Explore › Who to follow (route `/explore/who-to-follow`) — recommended accounts
 * for the viewer to follow, backed by the shared `useRecommendations` cache.
 */
export default function ExploreWhoToFollowScreen() {
  return <LazyWhoToFollowTab />;
}
