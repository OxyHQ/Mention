// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useState } from 'react';

/**
 * True until the feed first presents: its leading element has settled
 * (`leadingPending`) AND its first page is ready. Until then the feed shows only
 * its loading state — no leading element — so neither can land on top of the
 * other; after that it latches and never holds again (a refresh keeps both on
 * screen). See `leadingPending` in `Feed.web.tsx`.
 */
export function useHoldForLeading(
  leadingPending: boolean | undefined,
  firstPageReady: boolean,
): boolean {
  const [released, setReleased] = useState(!leadingPending && firstPageReady);
  if (!released && !leadingPending && firstPageReady) setReleased(true);
  return !released;
}
