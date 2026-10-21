import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { useIsFocused } from '@/lib/navigation/router';
import { useScreenViewport } from '@oxy.so/bloom/screen';
import type { FeedImpressionTracker } from '@/utils/feedTelemetry';

/** Viewport intersection alone remains true under another route or background app. */
export function useFeedVisibility(
  trackerRef: { current: FeedImpressionTracker },
  visibleOutsideApp = false,
): void {
  const focused = useIsFocused();
  const screenActive = useScreenViewport()?.active !== false;
  const tracker = trackerRef.current;
  useEffect(() => {
    const update = () => {
      const foreground =
        Platform.OS === 'web'
          ? typeof document === 'undefined' || document.visibilityState !== 'hidden'
          : AppState.currentState === null || AppState.currentState === 'active';
      tracker.setActive(visibleOutsideApp || (focused && screenActive && foreground));
    };
    update();
    const subscription = AppState.addEventListener('change', update);
    if (Platform.OS === 'web' && typeof document !== 'undefined')
      document.addEventListener('visibilitychange', update);
    return () => {
      subscription.remove();
      if (Platform.OS === 'web' && typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', update);
      tracker.setActive(false);
    };
  }, [tracker, focused, screenActive, visibleOutsideApp]);
}
