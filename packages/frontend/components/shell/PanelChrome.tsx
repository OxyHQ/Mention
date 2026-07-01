import React, { createContext, useContext } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';
import { cn } from '@/lib/utils';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';

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

/**
 * Height (px) of the horizontal tab bar (`AnimatedTabBar`) that stacks below a
 * header on the home/explore screens. Combined with `PANEL_HEADER_HEIGHT` it
 * gives the total two-tier chrome height reserved above the feed on NATIVE (where
 * the chrome is an absolute overlay and the feed carries this as a fixed top
 * inset — see `PANEL_CHROME_TOP_INSET`).
 */
export const PANEL_TABBAR_HEIGHT = 42;

/**
 * NATIVE fixed top inset (px) for a feed that scrolls BEHIND a header + tab bar
 * overlay (home, explore). The feed reserves this much scrollable top padding —
 * constant whether the chrome is shown or hidden — so the absolutely-positioned
 * chrome only ever TRANSLATES and hiding it never reflows the scrollable content
 * (the reflow feedback that used to feed the auto-hide loop near the bottom).
 * Web is unaffected: there the chrome is `position: sticky` in normal flow, so no
 * inset is needed (and the feed ignores this value on web).
 */
export const PANEL_CHROME_TOP_INSET = PANEL_HEADER_HEIGHT + PANEL_TABBAR_HEIGHT;

/**
 * Provides the NATIVE fixed top inset a feed must reserve when it scrolls behind
 * an auto-hiding header + tab bar overlay. A screen wraps its scroller (or its
 * `<Slot/>`) in `PanelChromeTopInsetProvider` and the `Feed` reads it via
 * `usePanelChromeTopInset`, applying it as scrollable top padding + a matching
 * `RefreshControl` offset on native. Default 0 → any feed NOT under an auto-hiding
 * chrome (embedded profile feed, standalone pages) is unaffected.
 */
const PanelChromeTopInsetContext = createContext<number>(0);

export function PanelChromeTopInsetProvider({ value, children }: { value: number; children: React.ReactNode }) {
    return (
        <PanelChromeTopInsetContext.Provider value={value}>
            {children}
        </PanelChromeTopInsetContext.Provider>
    );
}

/** The fixed top inset a feed must reserve for the overlay chrome above it (native). 0 when not under an auto-hiding chrome. */
export function usePanelChromeTopInset(): number {
    return useContext(PanelChromeTopInsetContext);
}

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
 * screen).
 *
 * Breakpoint-aware: the `PANEL_TOP_INSET` gutter only exists while the rounded
 * shell frame is shown. That frame is gated on the SAME `useIsScreenNotMobile`
 * (>=500px) breakpoint as the left sidebar, so once the shell drops to
 * full-bleed (sidebar hidden) the gutter is gone and this inset collapses to 0
 * — the chrome pins flush to the viewport top instead of leaving a stray gutter
 * band. Empty on native, where those layers are absolute overlays.
 */
export function usePanelStickyTopInset(): ViewStyle {
    const framed = useIsScreenNotMobile();
    return IS_WEB ? { top: framed ? PANEL_TOP_INSET : 0 } : {};
}

/**
 * Web-only `top` offset (px) for the SECOND tier of bespoke sticky chrome — a
 * row that must pin directly BELOW a `usePanelStickyTopInset` header band so the
 * two stack instead of overlapping. This is the `level={1}` analogue of
 * `usePanelStickyTopInset` for layers that can't use the full <PanelStickyHeader>
 * wrapper (e.g. the profile tab bar, which pins flush under the profile's
 * 0-flow-height header chrome — banner fade + action cluster + compact name).
 * Derived from the SAME constants as the home `level={1}` header, so the stacked
 * offset has one source of truth: framed = `PANEL_TOP_INSET + PANEL_HEADER_HEIGHT`
 * (`web:top-[56px]`); full-bleed drops the top gutter so it pins at just
 * `PANEL_HEADER_HEIGHT` (`web:top-[48px]`), in lockstep with the level-0 inset
 * above. Empty on native, where the header chrome is an absolute overlay and the
 * tab bar pins via `stickyHeaderIndices`.
 */
export function usePanelStickyTabsTopInset(): ViewStyle {
    const framed = useIsScreenNotMobile();
    return IS_WEB
        ? { top: framed ? PANEL_TOP_INSET + PANEL_HEADER_HEIGHT : PANEL_HEADER_HEIGHT }
        : {};
}

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
 * The web sticky inset for a given chrome level, in BOTH shell states. NativeWind
 * needs the class present as a string literal at build time, so all four
 * positions are spelled out rather than interpolated — but the OFFSET VALUES are
 * still derived from the exported constants (single source of truth): `framed`
 * pins at `PANEL_TOP_INSET` (`web:top-2` = 8px) / `PANEL_TOP_INSET +
 * PANEL_HEADER_HEIGHT` (`web:top-[56px]`); `bleed` drops the top gutter to 0
 * (`web:top-0`) / `PANEL_HEADER_HEIGHT` (`web:top-[48px]`). Which column is used
 * is selected by the SAME `useIsScreenNotMobile` (>=500px) breakpoint that shows
 * the left sidebar + the rounded shell frame, so the chrome's top gutter
 * collapses to 0 in lockstep with the frame at full-bleed.
 */
const STICKY_TOP_CLASS: Record<'framed' | 'bleed', Record<ChromeLevel, string>> = {
    framed: { 0: 'web:top-2', 1: 'web:top-[56px]' },
    bleed: { 0: 'web:top-0', 1: 'web:top-[48px]' },
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
    // The rounded shell frame (gutter inset + rounded corners) is shown only at
    // the same >=500px breakpoint as the left sidebar. Below it the shell is
    // full-bleed, so the chrome pins flush (`web:top-0`) with no rounded top
    // corners instead of leaving a stray gutter band — the same `framed` signal
    // drives the layout frame in `app/(app)/_layout.tsx`.
    const framed = useIsScreenNotMobile();
    return (
        <Animated.View
            pointerEvents={pointerEventsNone ? 'none' : 'auto'}
            className={cn(
                'left-0 right-0',
                IS_WEB && 'web:sticky',
                IS_WEB && STICKY_TOP_CLASS[framed ? 'framed' : 'bleed'][level],
                IS_WEB && opaque && 'web:bg-card',
                IS_WEB && rounded && framed && 'web:rounded-t-[28px]',
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
    // Same `framed` signal as PanelStickyHeader / the layout frame: the bottom
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
