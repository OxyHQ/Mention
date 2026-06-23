import React from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';
import { cn } from '@/lib/utils';

/**
 * Centralized panel insets + sticky chrome for the desktop-web rounded center
 * panel (the `bg-card` card that floats inside the 8px gutter in
 * `app/(app)/_layout.tsx`).
 *
 * THE PROBLEM THIS SOLVES — before this module, every screen hand-wrote its own
 * `web:sticky web:top-2` / `web:sticky web:top-[56px]` sticky offsets plus the
 * `web:bg-card` + `web:rounded-t-[28px]` corner-masking and the z-index it must
 * sit at. Those magic insets (8px gutter, 56px = gutter + header height) were
 * duplicated across home, explore, profile and the secondary pages, so a change
 * to the gutter or header height meant touching every screen. This component
 * owns that math ONCE.
 *
 * WEB layering contract (matches the z-ladder documented in
 * `app/(app)/_layout.tsx`): feed z-0 < bleed mask z-30 < sticky chrome
 * z-100/101 < panel border frame z-120. Chrome must pin at `PANEL_TOP_INSET`
 * (NOT top:0) because the bleed mask paints a 40px gutter ring over the top
 * `PANEL_TOP_INSET` px of the viewport — a header at top:0 would be clipped by
 * that ring. The opaque `bg-card` surface + `rounded-t-[28px]` corners on the
 * chrome ALSO mask the feed's top-edge bleed in the panel's rounded corners.
 *
 * NATIVE: pass-through. `PanelStickyHeader` becomes the screen's
 * absolute/relative overlay anchor (the inner ScrollView owns the scroll), and
 * `PanelStickyFooter` becomes a bottom-anchored absolute overlay — exactly the
 * positioning the screens used before centralization.
 */

const IS_WEB = Platform.OS === 'web';

/** Gutter inset (px) between the rounded panel's top edge and the viewport top. */
export const PANEL_TOP_INSET = 8;

/** Gutter inset (px) between the rounded panel's bottom edge and the viewport bottom. */
export const PANEL_BOTTOM_INSET = 8;

/**
 * Height (px) of a single header row stacked above a sticky tab bar. A
 * `level={1}` sticky element (the tab bar) pins at `PANEL_TOP_INSET + this`, so
 * the stacked-offset math lives here once instead of as a `web:top-[56px]`
 * literal on each screen.
 */
export const PANEL_HEADER_HEIGHT = 48;

/** z-index the sticky chrome paints at — above feed (0) and bleed mask (30), below the border frame (120). */
const CHROME_Z_INDEX = 101;

/**
 * Web-only `top` offset (px) for BESPOKE sticky chrome layers that cannot use
 * the full <PanelStickyHeader> wrapper without breaking their own animations or
 * overlapping z-layout — e.g. the profile banner-fade / name-fade / sticky-tabs
 * stack, which each pin at the panel's top gutter inset but carry their own
 * `web:z-[…]`, negative margins and pointer-events. Those layers keep their
 * `web:sticky` class and spread this style so the inset value still comes from
 * the single `PANEL_TOP_INSET` source of truth (no literal `web:top-2` per
 * screen). Empty on native, where those layers are absolute overlays.
 */
export const panelStickyTopInset: ViewStyle = IS_WEB ? { top: PANEL_TOP_INSET } : {};

/**
 * Web-only `top` offset (px) for the SECOND tier of bespoke sticky chrome — a
 * row that must pin directly BELOW a `panelStickyTopInset` header band so the
 * two stack instead of overlapping. This is the `level={1}` analogue of
 * `panelStickyTopInset` for layers that can't use the full <PanelStickyHeader>
 * wrapper (e.g. the profile tab bar, which pins flush under the profile's
 * 0-flow-height header chrome — banner fade + action cluster + compact name).
 * Derived from the SAME constants as the home `level={1}` header
 * (`PANEL_TOP_INSET + PANEL_HEADER_HEIGHT` = `web:top-[56px]`), so the stacked
 * offset has one source of truth. Empty on native, where the header chrome is
 * an absolute overlay and the tab bar pins via `stickyHeaderIndices`.
 */
export const panelStickyTabsTopInset: ViewStyle = IS_WEB
    ? { top: PANEL_TOP_INSET + PANEL_HEADER_HEIGHT }
    : {};

type ChromeLevel = 0 | 1;

interface PanelStickyHeaderProps {
    children: React.ReactNode;
    /**
     * 0 = top header (pins at `PANEL_TOP_INSET`). 1 = a row stacked directly
     * below a `level={0}` header (pins at `PANEL_TOP_INSET + PANEL_HEADER_HEIGHT`).
     */
    level?: ChromeLevel;
    /** z-index override (web). Defaults to the chrome layer (101). */
    zIndex?: number;
    /** Paint the opaque panel surface (`bg-card`) so the feed never shows through. Default true. */
    opaque?: boolean;
    /** Mask the panel's top rounded corners (`rounded-t-[28px]`). Default true. */
    rounded?: boolean;
    /**
     * Make the sticky wrapper itself ignore pointer events (web). Used by the
     * profile chrome, where a full-width 0-flow-height anchor hosts an absolute,
     * pointer-events-auto child so it never blocks the feed underneath.
     */
    pointerEventsNone?: boolean;
    /**
     * Reanimated OR plain style. Typed as `StyleProp<AnimatedStyle<ViewStyle>>`
     * — the exact `style` type of the underlying `Animated.View` — so callers
     * can hand it either a plain `ViewStyle` (`panelStickyTopInset`) or the
     * `AnimatedStyleHandle` returned by `useAnimatedStyle` (the home/explore
     * auto-hide translate) without a cast. `ViewStyle` is assignable to
     * `AnimatedStyle<ViewStyle>`, so plain-style callers keep working.
     */
    style?: StyleProp<AnimatedStyle<ViewStyle>>;
    /** Extra classes appended after the centralized chrome classes. */
    className?: string;
}

/**
 * The web sticky inset for a given chrome level. NativeWind needs the class
 * present as a string literal at build time, so the two levels are spelled out
 * rather than interpolated — but the OFFSET VALUES are derived from the
 * exported constants, so there is a single source of truth (`web:top-2` is
 * `PANEL_TOP_INSET` rem/4 = 8px; `web:top-[56px]` is `PANEL_TOP_INSET +
 * PANEL_HEADER_HEIGHT`).
 */
const STICKY_TOP_CLASS: Record<ChromeLevel, string> = {
    0: 'web:top-2',
    1: 'web:top-[56px]',
};

/**
 * Sticky chrome row pinned at the rounded panel's top gutter inset on web; a
 * positioned overlay anchor on native.
 */
export function PanelStickyHeader({
    children,
    level = 0,
    zIndex = CHROME_Z_INDEX,
    opaque = true,
    rounded = true,
    pointerEventsNone = false,
    style,
    className,
}: PanelStickyHeaderProps) {
    return (
        <Animated.View
            pointerEvents={pointerEventsNone ? 'none' : 'auto'}
            className={cn(
                'left-0 right-0',
                IS_WEB && 'web:sticky',
                IS_WEB && STICKY_TOP_CLASS[level],
                IS_WEB && opaque && 'web:bg-card',
                IS_WEB && rounded && 'web:rounded-t-[28px]',
                IS_WEB && pointerEventsNone && 'web:pointer-events-none',
                className,
            )}
            style={[
                Platform.select({
                    web: { zIndex },
                    default: {
                        // Native: the inner ScrollView owns the scroll, so the
                        // header is an absolute overlay at the top; a stacked
                        // row (level 1) sits in normal flow under it.
                        position: level === 0 ? ('absolute' as const) : ('relative' as const),
                        top: 0,
                        backgroundColor: 'transparent',
                        zIndex,
                    },
                }),
                style,
            ]}
        >
            {children}
        </Animated.View>
    );
}

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
 * WEB `web:bottom-2` (= PANEL_BOTTOM_INSET, NOT 0): the bleed-mask's 40px
 * gutter box-shadow covers the bottom `PANEL_BOTTOM_INSET` px of the viewport,
 * so a footer at bottom:0 would be clipped. The footer rounds its OWN bottom
 * corners (`md:rounded-b-[28px]`) to match the panel and `web:shrink-0` keeps it
 * from collapsing. The web `position: sticky` lives in the `web:sticky` class
 * (RN's typed `ViewStyle.position` has no `'sticky'`, so it is never written as
 * an inline style here). NATIVE: a bottom-anchored absolute overlay.
 */
export function PanelStickyFooter({
    children,
    zIndex,
    className,
    style,
}: PanelStickyFooterProps) {
    return (
        <Animated.View
            className={cn(
                'w-full',
                IS_WEB && 'web:sticky web:bottom-2 web:shrink-0 md:rounded-b-[28px]',
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
