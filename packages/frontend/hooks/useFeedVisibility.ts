// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useEffect } from 'react';
import { useScreenVisible } from '@oxy.so/bloom/screen';
import type { FeedImpressionTracker } from '@/utils/feedTelemetry';

/**
 * Dwell accrues only while the reader can see the feed: its Screen is in front
 * and the app is in the foreground. Viewport intersection alone stays true under
 * another route or a backgrounded app. `visibleOutsideApp` is an OS
 * Picture-in-Picture window, which stays visible either way.
 */
export function useFeedVisibility(
  trackerRef: { current: FeedImpressionTracker },
  visibleOutsideApp = false,
): void {
  const visible = useScreenVisible() || visibleOutsideApp;
  const tracker = trackerRef.current;
  useEffect(() => {
    tracker.setActive(visible);
    return () => tracker.setActive(false);
  }, [tracker, visible]);
}
