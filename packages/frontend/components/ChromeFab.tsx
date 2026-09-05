import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import Animated, { runOnJS, useAnimatedReaction, useAnimatedStyle } from 'react-native-reanimated';

import { Fab } from '@oxyhq/bloom/fab';

import { useBottomBarHidden } from '@/context/BottomBarVisibilityContext';

const IS_WEB = Platform.OS === 'web';

/** Above this much of the hide travel the FAB is invisible and must stop taking taps. */
const GONE_THRESHOLD = 0.99;

interface ChromeFabProps {
    onPress: () => void;
    icon: React.ReactNode;
    accessibilityLabel: string;
    /** Pixel diameter (defaults to the 48px Mention FAB; Bloom's `medium` is 56). */
    size?: number;
}

/**
 * The compose FAB, fading with the rest of the app chrome.
 *
 * WHERE the FAB sits is Bloom's job and it does it: `Fab` reads the bottom edge's
 * claimed footprint, so it clears the floating BottomBar on every platform
 * without this component knowing the bar exists.
 *
 * WHEN it moves is Mention's, and it has to be, which is the whole reason this
 * file exists. Bloom published the bar's collapse through its registry twice —
 * as a live height, then as a boolean — and both felt wrong on a device: the bar
 * animates on the UI thread while a React consumer arrives via `runOnJS` plus two
 * render passes, so the FAB started one to three frames late, by a variable
 * amount, worst exactly while scrolling. Fading rather than moving did not hide
 * it; the eye still saw two pieces of chrome change at different moments.
 *
 * So the motion comes from `useBottomBarHidden()` instead — the same continuous
 * 0..1 shared value that drives the bar's minimize and the home/explore headers'
 * translate, read the same way they read it. Nothing crosses a thread, so there
 * is no lag to be in sync with: the FAB cannot drift from chrome it is literally
 * interpolating off the same number as.
 *
 * WEB renders Bloom's `Fab` unwrapped, and that is deliberate rather than an
 * omission. Its web fork places itself with `position: sticky` + `margin-top:
 * auto` + `align-self`, which only work while it is a direct child of the
 * consumer's flex column — a wrapper node would silently break its placement.
 * A statically-placed FAB is correct and can never desync; only the fade is lost.
 */
export function ChromeFab({ onPress, icon, accessibilityLabel, size = 48 }: ChromeFabProps) {
    const hidden = useBottomBarHidden();

    // Non-visual, so this one CAN take the slow road: a tap landing on a FAB that
    // is already invisible (or missing one that is about to be) for a frame or
    // two is imperceptible, where the same lag on the fade itself is exactly the
    // defect this component exists to avoid.
    const [gone, setGone] = useState(false);
    useAnimatedReaction(
        () => hidden.value > GONE_THRESHOLD,
        (isGone, wasGone) => {
            if (isGone !== wasGone) runOnJS(setGone)(isGone);
        },
        [hidden],
    );

    const fadeStyle = useAnimatedStyle(() => ({ opacity: 1 - hidden.value }), [hidden]);

    const fab = (
        <Fab
            size={size}
            onPress={onPress}
            icon={icon}
            accessibilityLabel={accessibilityLabel}
        />
    );

    if (IS_WEB) return fab;

    // A plain wrapper: it takes no placement of its own, so the FAB inside keeps
    // resolving `position: absolute` against the screen container exactly as it
    // does unwrapped. Opacity applies to the subtree regardless.
    return (
        <Animated.View
            style={fadeStyle}
            pointerEvents={gone ? 'none' : 'box-none'}
            accessibilityElementsHidden={gone}
            importantForAccessibility={gone ? 'no-hide-descendants' : 'auto'}
        >
            {fab}
        </Animated.View>
    );
}
