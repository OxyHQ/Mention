import { useAnimatedScrollHandler } from 'react-native-reanimated';
import { useLayoutScroll } from '@/context/LayoutScrollContext';

/**
 * A list's scroll handler that only reports its offset to the shared
 * `scrollPosition`, from a UI-thread worklet. That value has two readers, the
 * auto-hiding chrome and the reselect "already at the top?" check, and neither
 * needs the offset pushed to the JS thread. As a JS callback it could only
 * arrive when the JS thread was free, which on a list of posts is exactly when
 * it is not.
 */
export function useScrollPositionHandler() {
    const { scrollPosition } = useLayoutScroll();
    return useAnimatedScrollHandler({
        onScroll: (event) => {
            'worklet';
            scrollPosition.value = event.contentOffset.y;
        },
    });
}
