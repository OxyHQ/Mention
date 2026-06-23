import React from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { Fab } from '@oxyhq/bloom/fab';
import { useAuth } from '@oxyhq/services';

import { BOTTOM_BAR_RESERVED_SPACE } from '@/components/BottomBar';
import { useBottomBarHidden } from '@/context/BottomBarVisibilityContext';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';

const IS_WEB = Platform.OS === 'web';

/** Base gap (px) between the FAB and its anchored edges. Matches Bloom's default. */
const FAB_BASE_OFFSET = 16;

interface BottomBarAwareFabProps {
    onPress: () => void;
    icon: React.ReactNode;
    accessibilityLabel: string;
    /** Pixel diameter (defaults to the 48px Mention FAB). */
    size?: number;
}

/**
 * The Mention compose/search FAB that floats bottom-right of the central column
 * and stays clear of the BottomBar.
 *
 * On mobile-web the BottomBar is `position: fixed` to the viewport bottom, and in
 * the document-scroll model the FAB's sticky anchor pins it to the viewport
 * bottom too — so a static FAB would land ON the bar. This component lifts the
 * FAB by the bar's reserved footprint WHILE THE BAR IS VISIBLE and lets it drop
 * back to the base 16px edge gap WHEN THE BAR AUTO-HIDES, driven by the SAME
 * shared `hidden` signal that slides the bar (one scroll listener, one timing).
 * The motion is a reanimated `translateY` on an `Animated.View` wrapper around a
 * `placement="static"` Bloom FAB — animated on the UI thread, never a per-frame
 * re-render of `<Fab>`.
 *
 * Everywhere the bar does not participate (desktop web, native, or anonymous
 * mobile-web) it renders the plain Bloom `bottom-right` FAB at the 16px gap.
 */
export function BottomBarAwareFab({ onPress, icon, accessibilityLabel, size = 48 }: BottomBarAwareFabProps) {
    const insets = useSafeAreaInsets();
    const isScreenNotMobile = useIsScreenNotMobile();
    const { isAuthenticated } = useAuth();
    const hidden = useBottomBarHidden();

    // The bar only renders (and only needs avoiding) on authenticated mobile-web.
    const followsBottomBar = IS_WEB && !isScreenNotMobile && isAuthenticated;

    // Lift = the bar footprint + safe-area inset; fully applied when the bar is
    // visible (hidden = 0) so the FAB floats above it, and removed as the bar
    // hides (hidden = 1) so the FAB rides down to its base 16px gap. Mapping
    // translateY 0 at hidden=1 → -lift at hidden=0 is `-(1 - hidden) * lift`.
    const liftDistance = BOTTOM_BAR_RESERVED_SPACE + insets.bottom;
    const followStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: -(1 - hidden.value) * liftDistance }],
    }), [liftDistance]);

    if (!followsBottomBar) {
        return (
            <Fab
                size={size}
                onPress={onPress}
                offset={FAB_BASE_OFFSET}
                icon={icon}
                accessibilityLabel={accessibilityLabel}
            />
        );
    }

    // Sticky bottom-right anchor for the wrapper (mirrors Bloom's web FAB
    // placement): `web:sticky` + `bottom` inset + `web:mt-auto` (pins to the
    // bottom of the flex column even when content is short) + `web:self-end` for
    // the right edge. NativeWind owns `position` (no inline 'sticky' cast).
    return (
        <Animated.View
            className="web:sticky web:self-end web:mt-auto web:z-[50]"
            style={[{ bottom: FAB_BASE_OFFSET, marginRight: FAB_BASE_OFFSET }, followStyle]}
        >
            <Fab
                size={size}
                onPress={onPress}
                placement="static"
                icon={icon}
                accessibilityLabel={accessibilityLabel}
            />
        </Animated.View>
    );
}
