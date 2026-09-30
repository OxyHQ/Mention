import React from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';
import { cn } from '@/lib/utils';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';

const IS_WEB = Platform.OS === 'web';

/** The thread's reply composer owns a local footer above shared app navigation.
 * It is not an app header, panel mask, or second shell. */
interface PanelStickyFooterProps {
    children: React.ReactNode;
    /** Extra classes appended after the centralized chrome classes. */
    className?: string;
    /** Reanimated OR plain style — same `Animated.View` style type as the header. */
    style?: StyleProp<AnimatedStyle<ViewStyle>>;
}

/** z-index the footer paints at so it floats over the scrolling content beneath it. */
const FOOTER_Z_INDEX = Platform.OS === 'web' ? 110 : 999;

/**
 * Transparent chrome pinned at the panel's bottom: `position: sticky` on web, a
 * bottom-anchored absolute overlay on native. It paints nothing itself — its
 * children float over the content scrolling beneath it.
 *
 * WEB `web:bottom-2` (= PANEL_BOTTOM_INSET) while the rounded shell frame is
 * shown, so the footer's children sit inside the frame's bottom gutter. The frame
 * is gated on the SAME `useIsScreenNotMobile` (>=500px) breakpoint as the left
 * sidebar; once the shell drops to full-bleed the footer pins flush
 * (`web:bottom-0`). `web:shrink-0` keeps it from collapsing. The web
 * `position: sticky` lives in the `web:sticky` class (RN's typed
 * `ViewStyle.position` has no `'sticky'`, so it is never written inline).
 */
export function PanelStickyFooter({
    children,
    className,
    style,
}: PanelStickyFooterProps) {
    const framed = useIsScreenNotMobile();
    return (
        <Animated.View
            className={cn(
                'w-full',
                IS_WEB && 'web:sticky web:shrink-0',
                IS_WEB && (framed ? 'web:bottom-2' : 'web:bottom-0'),
                className,
            )}
            style={[
                Platform.select({
                    web: { zIndex: FOOTER_Z_INDEX },
                    default: { position: 'absolute' as const, bottom: 0, left: 0, right: 0, zIndex: FOOTER_Z_INDEX },
                }),
                style,
            ]}
        >
            {children}
        </Animated.View>
    );
}
