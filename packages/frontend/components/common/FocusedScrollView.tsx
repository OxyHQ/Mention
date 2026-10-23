import type React from 'react';
import { useCallback } from 'react';
import {
  Platform,
  ScrollView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
  type ScrollViewInstance,
} from 'react-native';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { useFocusedScrollable } from '@/hooks/useFocusedScrollable';

/**
 * A screen's own ScrollView — the one that IS the page on native — owning the
 * shared scroll while its screen is in front: its offset reaches
 * `scrollPosition`, so the auto-hiding chrome follows it and reselecting the
 * screen knows whether it is at the top, and its ref is the one `scrollToTop`
 * drives.
 *
 * The offset travels on the JS thread. That is fine for the short, light
 * screens this is for; a long list of posts reports from a worklet instead
 * (`FocusedFlashList`).
 *
 * On web the document is the scroller, so this is a plain ScrollView.
 */
function NativeFocusedScrollView({ onScroll, contentContainerStyle, ...props }: ScrollViewProps) {
  const { handleScroll, scrollEventThrottle } = useLayoutScroll();
  // The view scrolls under the shell's bottom bar; its end clears it.
  const bottomEdge = useBottomEdgeInset();
  const ref = useFocusedScrollable<ScrollViewInstance>({ initialOffset: 0 });
  const handleOwnScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      handleScroll(event);
      onScroll?.(event);
    },
    [handleScroll, onScroll],
  );
  return (
    <ScrollView
      {...props}
      contentContainerStyle={[{ paddingBottom: bottomEdge }, contentContainerStyle]}
      ref={ref}
      onScroll={handleOwnScroll}
      scrollEventThrottle={scrollEventThrottle}
    />
  );
}

export const FocusedScrollView: React.ComponentType<ScrollViewProps> =
  Platform.OS === 'web' ? ScrollView : NativeFocusedScrollView;
