import React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';
import { EdgeScrim, SCRIM_TAIL_RATIO } from '@oxy.so/bloom/page-header';
import { useSurfaceFill } from '@oxy.so/bloom/styles';
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
 * Chrome pinned at the panel's bottom: `position: sticky` on web, a
 * bottom-anchored absolute overlay on native. It paints no rectangle — a solid
 * footer ends at its own top edge, and that edge reads as a band around what
 * floats in it. Instead it carries the floating header's edge effect mirrored
 * (Bloom's `EdgeScrim edge="bottom"`): the column's own surface at the bottom,
 * fading to nothing `SCRIM_TAIL_RATIO` of the footer's height ABOVE it, so the
 * fade finishes past the layout rather than at it. A caller clearing a bar or
 * safe area passes it as `paddingBottom`, which keeps the scrim reaching the
 * edge.
 *
 * WEB `web:bottom-2` (= PANEL_BOTTOM_INSET) while the rounded shell frame is
 * shown, and the scrim rounds its bottom corners to the frame's 28px so its
 * solid end never squares off the panel's corners. The frame is gated on the
 * SAME `useIsScreenNotMobile` (>=500px) breakpoint as the left sidebar; once
 * the shell drops to full-bleed the footer pins flush (`web:bottom-0`).
 * `web:shrink-0` keeps it from collapsing. The web `position: sticky` lives in
 * the `web:sticky` class (RN's typed `ViewStyle.position` has no `'sticky'`,
 * so it is never written inline).
 */
export function PanelStickyFooter({
    children,
    className,
    style,
}: PanelStickyFooterProps) {
    const framed = useIsScreenNotMobile();
    const surfaceFill = useSurfaceFill();
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
            <View
                // A PROP: react-native-web resolves `none` from the prop path only.
                pointerEvents="none"
                className={cn(IS_WEB && framed && 'web:overflow-hidden web:rounded-b-[28px]')}
                style={styles.scrim}
            >
                <EdgeScrim edge="bottom" color={surfaceFill} />
            </View>
            {children}
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    // A percentage `top` resolves against the footer's own height on both
    // platforms, so the tail follows the footer without measuring it.
    scrim: { position: 'absolute', left: 0, right: 0, bottom: 0, top: `${-SCRIM_TAIL_RATIO * 100}%` },
});
