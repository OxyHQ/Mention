// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { LazyAccountInfoScreen } from '@/components/sharedRouteScreens';

/**
 * A PERSON's about page.
 *
 * The screen itself is shared with `/c/<handle>/about` — what an account is
 * reads the same whoever it belongs to. Only the URL family differs, and it is
 * declared here rather than sniffed, so the shared screen can canonicalize a
 * reader who arrived on the wrong one.
 */
export default function ProfileAboutRoute() {
  return <LazyAccountInfoScreen routedFamily="person" />;
}
