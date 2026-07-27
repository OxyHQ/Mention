import { View } from 'react-native';
import { Bell, BellActive, ComposeIcon, ComposeIIconActive, Home, HomeActive, Video, VideoActive } from '@/assets/icons';
import { useRouter, usePathname } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types';

import { useAuth } from '@oxyhq/services';
import { useHaptics } from '@oxyhq/bloom/hooks';
import {
    TabBar,
    TabBarButton,
    useTabBarReservedSpace,
    type TabBarItem,
    type TabBarTheme,
} from '@oxyhq/bloom/tab-bar';
import { useHomeRefresh } from '@/context/HomeRefreshContext';
import { useUnreadCount } from '@/hooks/useUnreadCount';
import { UnreadBadge } from '@/components/notifications/UnreadBadge';
import { useTranslation } from 'react-i18next';

/**
 * Forced-dark palette for the fullscreen Reels (/videos) screen, where the bar
 * floats over dark video content regardless of the app theme. Everywhere else the
 * bar resolves all five colors from the Bloom theme on its own.
 *
 * `glassTint` is what the web surface paints under its `backdrop-filter`;
 * `solidFallback` is the near-opaque fill used where there is no glass to lens.
 * Both keep the #003038 surface the hand-rolled bar used on this screen.
 */
const VIDEOS_DARK_TAB_BAR_THEME: Partial<TabBarTheme> = {
    activeTint: '#FFFFFF',
    inactiveTint: 'rgba(255, 255, 255, 0.65)',
    highlight: 'rgba(255, 255, 255, 0.16)',
    glassTint: 'rgba(0, 48, 56, 0.8)',
    solidFallback: 'rgba(0, 48, 56, 0.94)',
};

/** Rendered size (px) of the tab glyphs; Bloom centers each one in its own glyph box. */
const ICON_SIZE = 22;

/** Tab order. Shared by the pathname → index derivation and the press handlers. */
const TAB_HOME = 0;
const TAB_VIDEOS = 1;
const TAB_COMPOSE = 2;
const TAB_NOTIFICATIONS = 3;
const TAB_PROFILE = 4;

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
    return useTabBarReservedSpace() + BOTTOM_BAR_CLEARANCE;
}

export const BottomBar = () => {
    const router = useRouter();
    const pathname = usePathname();
    const { showBottomSheet, signIn, user, isAuthenticated } = useAuth();
    const haptic = useHaptics();
    const { triggerHomeRefresh } = useHomeRefresh();
    const { t } = useTranslation();
    const unreadCount = useUnreadCount();

    // The Reels (/videos) screen floats this bar over dark video content, so it
    // renders against a forced-dark surface regardless of the app theme.
    const isVideosScreen = pathname === '/videos';

    const activeIndex = pathname === '/' ? TAB_HOME
        : pathname === '/videos' ? TAB_VIDEOS
        : pathname === '/compose' ? TAB_COMPOSE
        : pathname === '/notifications' ? TAB_NOTIFICATIONS
        : pathname.startsWith('/@') ? TAB_PROFILE
        : -1;

    const unreadLabel = t('notification.badge', {
        count: unreadCount,
        defaultValue: '{{count}} unread notifications',
    });

    const items = useMemo<TabBarItem[]>(() => [
        {
            name: 'home',
            label: t('bottomBar.home'),
            icon: <Home size={ICON_SIZE} className="text-muted-foreground" />,
            activeIcon: <HomeActive size={ICON_SIZE} className="text-primary" />,
        },
        {
            name: 'videos',
            label: t('bottomBar.videos'),
            icon: <Video size={ICON_SIZE} className="text-muted-foreground" />,
            activeIcon: <VideoActive size={ICON_SIZE} className="text-primary" />,
        },
        {
            name: 'compose',
            label: t('bottomBar.compose'),
            icon: <ComposeIcon size={ICON_SIZE} className="text-muted-foreground" />,
            activeIcon: <ComposeIIconActive size={ICON_SIZE} className="text-primary" />,
        },
        {
            // The unread badge is composed INTO both glyphs rather than living in a
            // slot of its own: Bloom has no badge slot, and the bar renders `icon`
            // and `activeIcon` as two stacked crossfade layers, so both must carry
            // it or it would blink mid-crossfade. The two copies are pixel-identical
            // and fully opaque, so the stack is invisible.
            //
            // HEADROOM: the badge is `-top-1` (-4px) inside a glyph box sitting 7px
            // below `itemBox`'s `overflow: 'hidden'` edge — 3px of clearance. If it
            // ever renders flat-topped, that clip is why. The real fix is a
            // Bloom-side badge slot rendered outside the crossfade, not a nudge here.
            name: 'notifications',
            label: t('bottomBar.notifications'),
            icon: (
                <View>
                    <Bell size={ICON_SIZE} className="text-muted-foreground" />
                    <UnreadBadge count={unreadCount} accessibilityLabel={unreadLabel} />
                </View>
            ),
            activeIcon: (
                <View>
                    <BellActive size={ICON_SIZE} className="text-primary" />
                    <UnreadBadge count={unreadCount} accessibilityLabel={unreadLabel} />
                </View>
            ),
        },
        {
            // No `activeIcon`: the avatar looks the same whether or not the tab is
            // focused, exactly as before — the sliding highlight carries the state.
            name: 'profile',
            label: t('bottomBar.profile'),
            icon: <Avatar size={ICON_SIZE + 4} source={user?.avatar} variant={MEDIA_VARIANT_AVATAR} />,
        },
    ], [t, unreadCount, unreadLabel, user?.avatar]);

    const handleIndexChange = useCallback((index: number) => {
        haptic('light');
        switch (index) {
            case TAB_HOME:
                // Re-tapping Home while the feed is already open refreshes it rather
                // than navigating.
                if (pathname === '/') {
                    triggerHomeRefresh();
                } else {
                    router.navigate('/');
                }
                break;
            case TAB_VIDEOS:
                router.navigate('/videos');
                break;
            case TAB_COMPOSE:
                // Compose is a modal-presented detail, not a tab root, so it PUSHES
                // over whatever screen is focused instead of switching tab roots.
                router.push('/compose');
                break;
            case TAB_NOTIFICATIONS:
                router.navigate('/notifications');
                break;
            case TAB_PROFILE:
                if (isAuthenticated && user?.username) {
                    router.navigate(`/@${user.username}`);
                } else {
                    // Dismissing the SDK sign-in modal rejects; that is an ordinary
                    // user action, not an error.
                    signIn().catch(() => {});
                }
                break;
        }
    }, [haptic, pathname, triggerHomeRefresh, router, isAuthenticated, user?.username, signIn]);

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
            {/* KNOWN ISSUE (accepted, not an oversight): Bloom paints a progressive
                blur across the bottom 114px of the window (120px in an iOS PWA)
                behind the pill. On /videos that band covers the Reels controls and
                visibly smears `scrubberHitArea`, the 3px progress line pinned at
                `bottom: 0`. There is deliberately NO consumer-side fix: on native the
                bar host is the LAST sibling of the shell, so no `zIndex` on a shell
                descendant can paint above it. The real fix is a `blur` control on
                Bloom's TabBar, landing in 0.53.0 — do not fight this with z-index. */}
            <TabBar
                activeIndex={activeIndex}
                onIndexChange={handleIndexChange}
                onIndexLongPress={handleIndexLongPress}
                theme={isVideosScreen ? VIDEOS_DARK_TAB_BAR_THEME : undefined}
            >
                {items.map((item, index) => (
                    <TabBarButton key={item.name} item={item} index={index} />
                ))}
            </TabBar>
        </View>
    );
};
