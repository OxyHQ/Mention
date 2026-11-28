// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { LazyAccountInfoScreen } from '@/components/sharedRouteScreens';

/**
 * A CHANNEL's about page.
 *
 * A channel has one of these for the same reason a person does: it is an Oxy
 * account with a joined date, a handle, a website and a place on the fediverse,
 * and its profile links here from the "Joined <date>" row. What it must NOT use
 * is `/@<handle>/about` — that route belongs to the person family, and a channel
 * sitting on it is a URL the account does not own.
 */
export default function ChannelAboutRoute() {
  return <LazyAccountInfoScreen routedFamily="channel" />;
}
