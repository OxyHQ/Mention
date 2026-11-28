// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { LazyOperatedAccountSettingsScreen } from '@/components/sharedRouteScreens';
import { useRoutedProfileUsername } from '@/components/Profile/hooks/useRoutedProfileUsername';

/**
 * A CHANNEL's settings, for its operators. The screen is shared with a
 * community's (`/@<handle>/settings`); see `OperatedAccountSettingsScreen`.
 */
export default function ChannelSettingsRoute() {
  const handle = useRoutedProfileUsername();
  return <LazyOperatedAccountSettingsScreen kind="channel" handle={handle} />;
}
