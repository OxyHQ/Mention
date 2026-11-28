// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { LazyOperatedAccountSettingsScreen } from '@/components/sharedRouteScreens';
import { useRoutedProfileUsername } from '@/components/Profile/hooks/useRoutedProfileUsername';
import { CommunitiesPreviewGate } from '@/hooks/useCommunitiesPreview';

/**
 * A COMMUNITY's settings, for its moderators. A community is a person-family
 * page (`/@<handle>`), so its settings live under that family; the screen is
 * shared with a channel's (`/c/<handle>/settings`), see
 * `OperatedAccountSettingsScreen`. Any other account here gets the screen's
 * operator-only answer.
 */
function CommunitySettingsScreen() {
  const handle = useRoutedProfileUsername();
  return <LazyOperatedAccountSettingsScreen kind="community" handle={handle} />;
}

export default function CommunitySettingsRoute() {
  return (
    <CommunitiesPreviewGate>
      <CommunitySettingsScreen />
    </CommunitiesPreviewGate>
  );
}
