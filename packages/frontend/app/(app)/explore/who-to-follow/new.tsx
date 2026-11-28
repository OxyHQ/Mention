// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { LazyNewUsersTab } from '@/components/sharedRouteScreens';

/**
 * Explore › Who to follow › New (route `/explore/who-to-follow/new`) — the
 * newest people on Oxy, in sign-up order. Not linked from the tab strip.
 */
export default function ExploreNewUsersScreen() {
  return <LazyNewUsersTab />;
}
