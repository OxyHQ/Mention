import { useEffect, useId, useState } from 'react';
import { Platform } from 'react-native';
import { useScreenVisible } from '@oxy.so/bloom/screen';
import { useNativeRowVisibility } from '@/context/VideoPlaybackContext';

/**
 * Whether a reference card is in front of the reader: its Screen is visible and
 * the card itself is on screen. Web measures the card; native uses FlashList's
 * actual viewable keys, never mounting.
 */
export function useReferenceVisibility(viewabilityKey?: string) {
  const id = `reference-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const screenVisible = useScreenVisible();
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
    visible: screenVisible && (Platform.OS === 'web' ? intersecting : nativeVisible),
  };
}
