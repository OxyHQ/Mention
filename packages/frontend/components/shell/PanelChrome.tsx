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
    /** z-index override (web). Defaults above the bleed mask so the footer's own surface masks the feed's bottom-edge bleed. */
    zIndex?: number;
    /** Extra classes appended after the centralized chrome classes. */
    className?: string;
    /** Reanimated OR plain style — same `Animated.View` style type as the header. */
    style?: StyleProp<AnimatedStyle<ViewStyle>>;
}

/** z-index the sticky footer paints at on WEB — above the bleed mask (30) so its opaque surface + rounded bottom corners mask the feed's bottom-edge bleed (matches the z-ladder in `app/(app)/_layout.tsx`). */
const FOOTER_Z_INDEX = 110;

/** z-index the bottom-anchored footer overlay paints at on NATIVE — high enough to float over scrollable screen content. */
const FOOTER_NATIVE_Z_INDEX = 999;

/**
 * Sticky chrome pinned at the rounded panel's bottom gutter inset on web; a
 * bottom-anchored absolute overlay on native.
 *
 * WEB `web:bottom-2` (= PANEL_BOTTOM_INSET, NOT 0) while the rounded frame is
 * shown: the bleed-mask's 40px gutter box-shadow covers the bottom
 * `PANEL_BOTTOM_INSET` px of the viewport, so a footer at bottom:0 would be
 * clipped, and the footer rounds its OWN bottom corners (`web:rounded-b-[28px]`)
 * to match the panel. The frame is gated on the SAME `useIsScreenNotMobile`
 * (>=500px) breakpoint as the left sidebar, so once the shell drops to
 * full-bleed (sidebar hidden, no bleed mask) the footer pins flush
 * (`web:bottom-0`) with no rounded corners — its bottom gutter collapses in
 * lockstep with the frame. `web:shrink-0` keeps it from collapsing. The web
 * `position: sticky` lives in the `web:sticky` class (RN's typed
 * `ViewStyle.position` has no `'sticky'`, so it is never written as an inline
 * style here). NATIVE: a bottom-anchored absolute overlay.
 */
export function PanelStickyFooter({
    children,
    zIndex,
    className,
    style,
}: PanelStickyFooterProps) {
    // Match the app shell frame: the bottom
    // gutter inset + rounded bottom corners exist only while the rounded shell
    // frame is shown (>=500px). Below it the shell is full-bleed → pin flush.
    const framed = useIsScreenNotMobile();
    return (
        <Animated.View
            className={cn(
                'w-full',
                IS_WEB && 'web:sticky web:shrink-0',
                IS_WEB && (framed ? 'web:bottom-2 web:rounded-b-[28px]' : 'web:bottom-0'),
                className,
            )}
            style={[
                Platform.select({
                    web: { zIndex: zIndex ?? FOOTER_Z_INDEX },
                    default: { position: 'absolute' as const, bottom: 0, left: 0, right: 0, zIndex: zIndex ?? FOOTER_NATIVE_Z_INDEX },
                }),
                style,
            ]}
        >
            {children}
        </Animated.View>
    );
}
