import React from 'react';
import { FlashList, type FlashListProps, type FlashListRef } from '@shopify/flash-list';
import Animated, { useAnimatedScrollHandler, type AnimatedProps } from 'react-native-reanimated';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { useFocusedScrollable } from '@/hooks/useFocusedScrollable';

/**
 * Built once at module scope: `createAnimatedComponent` returns a new component
 * type per call, and a new type per render would remount the list. It erases
 * FlashList's generic, so the cast gives it back.
 */
const AnimatedFlashList = Animated.createAnimatedComponent(FlashList) as unknown as <T>(
    props: AnimatedProps<FlashListProps<T>> & { ref?: React.Ref<FlashListRef<T>> },
) => React.ReactElement;

/**
 * A native FlashList that IS its screen's page — `FocusedScrollView`'s
 * counterpart for long lists. It owns the shared scroll while its screen is in
 * front, and reports its offset to `scrollPosition` from a UI-thread worklet.
 * That value has two readers, the auto-hiding chrome and the reselect "already
 * at the top?" check, and neither needs the offset on the JS thread; as a JS
 * callback it could only arrive when the JS thread was free, which on a list of
 * rows with avatars and text is exactly when it is not.
 */
export function FocusedFlashList<T>(props: Omit<FlashListProps<T>, 'onScroll' | 'scrollEventThrottle'>) {
    const { scrollPosition, scrollEventThrottle } = useLayoutScroll();
    const ref = useFocusedScrollable<FlashListRef<T>>({ initialOffset: 0 });
    const onScroll = useAnimatedScrollHandler({
        onScroll: (event) => {
            'worklet';
            scrollPosition.value = event.contentOffset.y;
        },
    });
    return (
        <AnimatedFlashList<T>
            {...props}
            ref={ref}
            onScroll={onScroll}
            scrollEventThrottle={scrollEventThrottle}
        />
    );
}
