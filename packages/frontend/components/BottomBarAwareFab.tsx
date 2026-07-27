import React from 'react';
import { Platform, View } from 'react-native';

import { Fab } from '@oxyhq/bloom/fab';
import { useTabBarReservedSpace } from '@oxyhq/bloom/tab-bar';
import { useAuth } from '@oxyhq/services';

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
 * On mobile-web the bar is pinned to the viewport bottom, and in the document-
 * scroll model the FAB's sticky anchor pins it to the viewport bottom too — so a
 * static FAB would land ON the bar. This lifts the FAB by the bar's footprint.
 *
 * The lift is CONSTANT: Bloom's bar minimizes (58 → 44) on scroll rather than
 * leaving the screen, so the FAB has to clear it at all times. Minimizing only
 * drops the pill's top edge, widening the gap — the two can never collide. That is
 * why there is no animation here; the offset is a plain layout value.
 *
 * Everywhere the bar does not participate (desktop web, native, or anonymous
 * mobile-web) it renders the plain Bloom `bottom-right` FAB at the 16px gap.
 */
export function BottomBarAwareFab({ onPress, icon, accessibilityLabel, size = 48 }: BottomBarAwareFabProps) {
    const isScreenNotMobile = useIsScreenNotMobile();
    const { isAuthenticated } = useAuth();
    // Bloom's raw footprint for the bar: the expanded pill plus the gap it keeps
    // from the window edge, safe-area inset already folded in. Never add
    // `insets.bottom` to it — that counts the home indicator twice.
    const reserved = useTabBarReservedSpace();

    // The bar only renders (and only needs avoiding) on authenticated mobile-web.
    const followsBottomBar = IS_WEB && !isScreenNotMobile && isAuthenticated;

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
    //
    // z-1001 is deliberate and MUST stay above the bar wrapper's z-1000: Bloom
    // paints a progressive blur reaching 114px up the window, and the lifted FAB
    // sits inside that band. Painted below the bar, the FAB's lower half renders
    // visibly backdrop-blurred. The two never overlap geometrically, so ordering
    // the FAB above the bar changes nothing except stopping the smear.
    return (
        <View
            className="web:sticky web:self-end web:mt-auto web:z-[1001]"
            style={{ bottom: FAB_BASE_OFFSET + reserved, marginRight: FAB_BASE_OFFSET }}
        >
            <Fab
                size={size}
                onPress={onPress}
                placement="static"
                icon={icon}
                accessibilityLabel={accessibilityLabel}
            />
        </View>
    );
}
