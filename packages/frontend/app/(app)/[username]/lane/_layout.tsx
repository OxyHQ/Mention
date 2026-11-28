// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { Slot } from '@/lib/navigation/router';

/**
 * The `lane` segment's navigator.
 *
 * It exists for the same reason the parent `[username]/_layout.tsx` renders a
 * `<Slot />` and not a screen, and that file carries the full account: a URL
 * segment with no navigator in the navigation state forces a client-side push
 * into one of its children to mount a navigator underneath a route the router
 * already resolved without it, and on web — where every route is an async chunk,
 * so the incoming screen suspends before it can commit — that mount and the
 * `usePathname()` it feeds chase each other until React aborts the render with
 * "Maximum update depth exceeded" (minified React error #185).
 *
 * The failure is invisible from a hard refresh: the route resolves in one pass
 * with no chunk boundary to suspend on. Only a client-side navigation into
 * `/@user/lane/<id>` — a lane chip in the feed, a lane tab on the profile —
 * reproduces it, which is exactly how every link into this segment is reached.
 */
const LaneLayout = () => <Slot />;

export default LaneLayout;
