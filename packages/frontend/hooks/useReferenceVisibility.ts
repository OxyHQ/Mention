import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { useIsFocused } from '@/lib/navigation/router';
import { useNativeRowVisibility } from '@/context/VideoPlaybackContext';

function subscribeForeground(listener: () => void) {
  if (Platform.OS === 'web') {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  }
  if (!AppState.isAvailable) return () => {};
  const subscription = AppState.addEventListener('change', listener);
  return () => subscription.remove();
}
const foreground = () =>
  Platform.OS === 'web'
    ? typeof document !== 'undefined' && document.visibilityState === 'visible'
    : AppState.currentState === null || AppState.currentState === 'active';

/** Web measures the card; native uses FlashList's actual viewable keys, never mounting. */
export function useReferenceVisibility(viewabilityKey?: string) {
  const id = `reference-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const focused = useIsFocused();
  const active = useSyncExternalStore(subscribeForeground, foreground, () => false);
  const nativeVisible = useNativeRowVisibility(viewabilityKey);
  const [intersecting, setIntersecting] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = document.getElementById(id);
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      setIntersecting(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [id]);
  return {
    nativeID: id,
    visible: focused && active && (Platform.OS === 'web' ? intersecting : nativeVisible),
  };
}
