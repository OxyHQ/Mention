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
