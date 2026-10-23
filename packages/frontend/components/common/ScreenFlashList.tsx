import type React from 'react';
import { useRef } from 'react';
import { StyleSheet } from 'react-native';
import { FlashList, type FlashListProps, type FlashListRef } from '@shopify/flash-list';
import Animated, { type AnimatedProps } from 'react-native-reanimated';
import { useScreenScroll } from '@oxy.so/bloom/screen';
import { useIsFocused } from '@/lib/navigation/router';
import { useReselectScroller } from '@/context/ScreenReselectContext';

/**
 * Built once at module scope: `createAnimatedComponent` returns a new component
 * type per call, and a new type per render would remount the list. It erases
 * FlashList's generic, so the cast gives it back.
 */
const AnimatedFlashList = Animated.createAnimatedComponent(FlashList) as unknown as <T>(
  props: AnimatedProps<FlashListProps<T>> & { ref?: React.Ref<FlashListRef<T>> },
) => React.ReactElement;

/**
 * A native FlashList that IS its Screen's scroller: Bloom drives the header
 * collapse and the bottom bar from it on the UI thread, and pads it clear of
 * the header and the bar it scrolls under. While its screen is in front it is
 * the scroller a reselect (or a profile's jump to its tabs) moves.
 */
export function ScreenFlashList<T>({
  contentContainerStyle,
  ...props
}: Omit<FlashListProps<T>, 'onScroll' | 'scrollEventThrottle'>) {
  const isFocused = useIsFocused();
  const ref = useRef<FlashListRef<T>>(null);
  const scroll = useScreenScroll({ active: isFocused });
  useReselectScroller({
    offset: () => scroll.scrollY.value,
    scrollToOffset: (offset) => ref.current?.scrollToOffset({ offset, animated: true }),
  });
  const padding = StyleSheet.flatten(contentContainerStyle) ?? {};
  return (
    <AnimatedFlashList<T>
      {...props}
      ref={ref}
      onScroll={scroll.onScroll}
      scrollEventThrottle={16}
      contentContainerStyle={{
        ...padding,
        paddingTop: scroll.contentInsets.top + Number(padding.paddingTop ?? padding.padding ?? 0),
        paddingBottom:
          scroll.contentInsets.bottom + Number(padding.paddingBottom ?? padding.padding ?? 0),
      }}
    />
  );
}
