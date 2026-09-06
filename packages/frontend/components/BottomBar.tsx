import { View } from 'react-native';
import { Home, HomeActive } from '@/assets/icons/home-icon';
import { Video, VideoActive } from '@/assets/icons/video-icon';
import { ComposeIcon, ComposeIIconActive } from '@/assets/icons/compose-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { usePathname } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';

import { useAuth } from '@oxyhq/services/ui/client';
import { useHaptics } from '@oxyhq/bloom/hooks';
import {
    TabBar,
    TabBarButton,
    useTabBarFootprint,
    type TabBarItem,
    type TabBarTheme,
} from '@oxyhq/bloom/tab-bar';
import { useHomeRefresh } from '@/context/HomeRefreshContext';
import { useTabPager } from '@/context/TabPagerContext';
import { TABS, tabIndexByName, type TabName } from '@/components/navigation/tabs';
import { useUnreadCount } from '@/hooks/useUnreadCount';
import { UnreadBadge } from '@/components/notifications/UnreadBadge';
import { useTranslation } from 'react-i18next';

/**
 * Forced black-and-white palette for the fullscreen Reels (/videos) screen, where
 * the bar floats over video regardless of the app theme. Everywhere else the bar
 * resolves all five colors from the Bloom theme on its own.
 *
 * NEUTRAL, not tinted: the surface sits over arbitrary footage, so any hue fights
 * whatever colour happens to be on frame. Black is the only surface that reads the
 * same over all of them — the convention every fullscreen video feed converges on.
 *
 * `glassTint` is what the web surface paints under its `backdrop-filter` and what
 * iOS layers over liquid glass, so a blur has already dissolved the frame behind
 * it: 0.72 is dark enough that a white glyph clears 9:1 contrast even over a blown-
 * out white frame, while still letting the blurred colour through so the pill reads
 * as glass rather than a slab punched into the video. `solidFallback` is the fill
 * used on Android and pre-iOS-26, where there is NO blur — sharp detail (a face,
 * burned-in captions) would otherwise read straight through the glyphs, so it has
 * to be near-opaque; 0.92 leaves just enough frame to keep it floating.
 *
 * `activeTint`/`inactiveTint` drive the LABELS only — Bloom interpolates between
 * them in its own mapper. The glyphs cannot follow them (see `activeGlyphClass`
 * below), so the className tints there are the deliberate twins of these values.
 * Inactive is 60% white rather than a heavier value so the selected tab is
 * unmistakable at a glance; it still clears 4.5:1 against the surface. `highlight`
 * is a touch stronger than Bloom's own scrim because a white scrim separates least
 * from the surface exactly when a bright frame lifts it toward mid-grey, and the
 * sliding pill is the bar's primary selection cue.
 */
const VIDEOS_DARK_TAB_BAR_THEME: Partial<TabBarTheme> = {
    activeTint: '#FFFFFF',
    inactiveTint: 'rgba(255, 255, 255, 0.6)',
    highlight: 'rgba(255, 255, 255, 0.2)',
    glassTint: 'rgba(0, 0, 0, 0.72)',
    solidFallback: 'rgba(0, 0, 0, 0.92)',
};

/** Rendered size (px) of the tab glyphs; Bloom centers each one in its own glyph box. */
const ICON_SIZE = 22;

/**
 * Tab order is `components/navigation/tabs.ts` — the one table the navigator's
 * triggers, this bar's items and the route→index question all read. These are
 * the two indices this file needs by NAME, resolved from it rather than written
 * down again: re-tapping Home refreshes the feed instead of navigating, and the
 * profile tab is the only one that long-presses.
 */
const TAB_HOME = tabIndexByName('index');
const TAB_PROFILE = tabIndexByName('you');

/**
 * Breathing margin (px) between the end of a screen's scrollable content and the
 * top of the pill, so the last row never sits flush against the bar.
 */
const BOTTOM_BAR_CLEARANCE = 12;

/**
 * Vertical space (px) a scrollable screen must leave free at its bottom for the
 * floating bar: Bloom's own footprint — the expanded pill plus the gap it keeps
 * from the window edge, with the bottom safe-area inset ALREADY folded in — plus
 * Mention's clearance.
 *
 * A hook rather than a constant because the footprint depends on the safe-area
 * inset. Never add `insets.bottom` to the result: Bloom folds the inset into its
 * own bottom gap, so adding it again counts the home indicator twice and strands a
 * band of dead space under every list.
 */
export function useBottomBarReservedSpace(): number {
    return useTabBarFootprint() + BOTTOM_BAR_CLEARANCE;
}

export const BottomBar = () => {
    const pathname = usePathname();
    const { showBottomSheet, user } = useAuth();
    const haptic = useHaptics();
    const { triggerHomeRefresh } = useHomeRefresh();
    const { t } = useTranslation();
    const unreadCount = useUnreadCount();
    const { progress, activeIndex, selectTab } = useTabPager();

    // The Reels (/videos) screen floats this bar over video content, so it renders
    // against a forced black-and-white surface regardless of the app theme.
    const isVideosScreen = pathname === '/videos';

    // The glyphs need their own copy of that decision because the theme cannot
    // reach them: Bloom tints a glyph by CLONING it with a `fill` prop, and
    // Mention's icons paint `currentColor` sourced from their className instead
    // (react-native-svg's `color` prop on native, the CSS cascade on web — see
    // `assets/icons/IconSvg.*`). `activeTint`/`inactiveTint` are therefore a silent
    // no-op on this icon set and the className is the only channel that works, so
    // these two are hand-matched to the theme's two tints above. Off /videos they
    // collapse to the app tokens, leaving every other screen's bar exactly as it
    // was and still following Bloom's light/dark theme.
    const activeGlyphClass = isVideosScreen ? 'text-white' : 'text-primary';
    const inactiveGlyphClass = isVideosScreen ? 'text-white/60' : 'text-muted-foreground';

    const unreadLabel = t('notification.badge', {
        count: unreadCount,
        defaultValue: '{{count}} unread notifications',
    });

    // Built FROM the tab table rather than beside it. The bar's order is the
    // pager's order — it decides which two tabs are neighbours under a swipe and
    // where the highlight sits — so a list written out separately here could
    // drift from the navigator's by a single reordered literal, and the symptom
    // would be a tap landing on the wrong screen.
    //
    // Keyed by the tab NAME and typed so every name in the table must have an
    // entry: `icon` is required by `TabBarItem`, so a tab added to the table with
    // no glyph here is a type error rather than a bar rendering `undefined`.
    const glyphs = useMemo<Record<TabName, Pick<TabBarItem, 'icon' | 'activeIcon'>>>(() => ({
        index: {
            icon: <Home size={ICON_SIZE} className={inactiveGlyphClass} />,
            activeIcon: <HomeActive size={ICON_SIZE} className={activeGlyphClass} />,
        },
        videos: {
            icon: <Video size={ICON_SIZE} className={inactiveGlyphClass} />,
            activeIcon: <VideoActive size={ICON_SIZE} className={activeGlyphClass} />,
        },
        write: {
            icon: <ComposeIcon size={ICON_SIZE} className={inactiveGlyphClass} />,
            activeIcon: <ComposeIIconActive size={ICON_SIZE} className={activeGlyphClass} />,
        },
        notifications: {
            // The unread badge is composed INTO both glyphs rather than living in a
            // slot of its own: Bloom has no badge slot, and the bar renders `icon`
            // and `activeIcon` as two stacked crossfade layers, so both must carry
            // it or it would blink mid-crossfade. The two copies are pixel-identical
            // and fully opaque, so the stack is invisible.
            //
            // The badge itself is NOT part of the forced-dark treatment: only the
            // two bell glyphs take `inactiveGlyphClass`/`activeGlyphClass`. It stays
            // `bg-primary` on every screen because it is an alert, not chrome — the
            // brand colour is what makes it read as one against a black bar.
            //
            // HEADROOM: the badge is `-top-1` (-4px) inside a glyph box sitting 7px
            // below `itemBox`'s `overflow: 'hidden'` edge — 3px of clearance. If it
            // ever renders flat-topped, that clip is why. The real fix is a
            // Bloom-side badge slot rendered outside the crossfade, not a nudge here.
            icon: (
                <View>
                    <Bell size={ICON_SIZE} className={inactiveGlyphClass} />
                    <UnreadBadge count={unreadCount} accessibilityLabel={unreadLabel} />
                </View>
            ),
            activeIcon: (
                <View>
                    <BellActive size={ICON_SIZE} className={activeGlyphClass} />
                    <UnreadBadge count={unreadCount} accessibilityLabel={unreadLabel} />
                </View>
            ),
        },
        you: {
            // No `activeIcon`: the avatar looks the same whether or not the tab is
            // focused, exactly as before — the sliding highlight carries the state.
            // It is also the one glyph the /videos treatment does not touch: an
            // <Avatar> is photographic content with no tint to force, so it renders
            // identically on every screen.
            icon: <Avatar size={ICON_SIZE + 4} source={user?.avatar} variant={MEDIA_VARIANT_AVATAR} />,
        },
    }), [activeGlyphClass, inactiveGlyphClass, unreadCount, unreadLabel, user?.avatar]);

    const items = useMemo<TabBarItem[]>(
        () =>
            TABS.map((tab) => ({
                name: tab.name,
                label: t(tab.labelKey),
                ...glyphs[tab.name],
            })),
        [glyphs, t],
    );

    // One line of navigation, plus the single tab that means something else when
    // it is already selected. Everything the old five-arm switch encoded —
    // which URL each tab is, popping whatever is pushed over the tabs, moving
    // the highlight — belongs to `selectTab` now, so the bar cannot disagree
    // with the navigator about any of it.
    //
    // The signed-out profile tab no longer opens the sign-in sheet from here:
    // `(tabs)/you.tsx` renders the prompt itself, which is the same thing for a
    // tap and the right thing for a deep link, a swipe, or a restored session
    // that turns out to be gone.
    const handleIndexChange = useCallback((index: number) => {
        haptic('light');
        // Re-tapping Home while the feed is already open refreshes it rather
        // than navigating.
        if (index === TAB_HOME && activeIndex === TAB_HOME) {
            triggerHomeRefresh();
            return;
        }
        selectTab(index);
    }, [haptic, activeIndex, triggerHomeRefresh, selectTab]);

    const handleIndexLongPress = useCallback((index: number) => {
        // Only the avatar tab has a long-press action (the account switcher).
        if (index !== TAB_PROFILE) return;
        haptic('heavy');
        showBottomSheet?.('ManageAccount');
    }, [haptic, showBottomSheet]);

    // POSITIONING: Bloom's bar pins itself with `position: absolute` against this
    // wrapper. On NATIVE the wrapper is a zero-height flex item at the end of the
    // shell column, so the bar lands on the window's bottom edge. On WEB the app
    // uses a DOCUMENT-scroll model (the window is the scroller), where `absolute`
    // would resolve against the tall document and scroll out of view — so the
    // wrapper pins to the viewport with `web:fixed web:inset-x-0 web:bottom-0` and
    // the bar's own `absolute` resolves against that instead. The classes carry the
    // `web:` prefix, so the wrapper is inert on native.
    return (
        <View className="web:fixed web:inset-x-0 web:bottom-0 web:z-[1000]">
            {/* Bloom paints a progressive blur across the bottom 118px of the window
                (a device inset makes it taller) behind the pill. Everywhere else that band is
                what dissolves scrolling content behind the bar, so it stays on. On
                /videos it is turned OFF: the band covered the Reels controls and
                smeared `scrubberHitArea`, the 3px progress line pinned at `bottom: 0`,
                and that screen already has its own 180px gradient overlay for
                legibility — two stacked bottom treatments over full-bleed video. There
                is no consumer-side fix for the smear, on either platform: the bar host
                is the LAST sibling of the shell, so no `zIndex` on a shell descendant
                can paint above it. Do not fight this with z-index; `blur` is the
                control. */}
            <TabBar
                // TWO PROPS, TWO QUESTIONS, ONE WRITER EACH. `activeIndex` says
                // whether there is a selection at all — it is -1 on every pushed
                // route this bar renders over, and Bloom fades the capsule out
                // where it stands. `activeProgress` says where the capsule IS,
                // every frame, on the UI thread: the pager writes it under the
                // finger, and off-native it is sprung on touch-up so the pill
                // arrives before the screen does. See `docs/tab-bar.mdx`.
                activeIndex={activeIndex}
                activeProgress={progress}
                onIndexChange={handleIndexChange}
                onIndexLongPress={handleIndexLongPress}
                theme={isVideosScreen ? VIDEOS_DARK_TAB_BAR_THEME : undefined}
                blur={!isVideosScreen}
            >
                {items.map((item, index) => (
                    <TabBarButton key={item.name} item={item} index={index} />
                ))}
            </TabBar>
        </View>
    );
};
