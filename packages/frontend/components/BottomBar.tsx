import { View, Pressable, Platform, LayoutChangeEvent, StyleSheet, type ViewStyle } from 'react-native';
import { Home, HomeActive, Video, VideoActive, ComposeIcon, ComposeIIconActive, BellActive, Bell } from '@/assets/icons';
import { useRouter, usePathname, type Href } from 'expo-router';
import React, { useCallback, useMemo, useRef } from 'react';
import { Avatar } from '@oxyhq/bloom/avatar';

import { useAuth } from '@oxyhq/services';
import { useTheme } from '@oxyhq/bloom/theme';
import { useHaptics } from '@/hooks/useHaptics';
import { useHomeRefresh } from '@/context/HomeRefreshContext';
import { useBottomBarHidden } from '@/context/BottomBarVisibilityContext';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';

// Dark-mode override palette for the fullscreen Reels (/videos) screen, where the
// bar floats over dark video content regardless of the app theme. Values are valid
// CSS color strings so alpha can be applied directly; elsewhere the bar derives its
// colors from the Bloom theme via NativeWind tokens.
const VIDEOS_DARK_PALETTE = {
    cardTranslucent: 'rgba(0, 48, 56, 0.8)', // #003038 @ 80%
    border: '#555555',
};

// Subtle frosted-glass blur radius for the web bar (medium, not extreme).
const WEB_BLUR_RADIUS = '12px';

/**
 * Web-only style extension. React Native's `ViewStyle` does not declare the CSS
 * backdrop-filter props, but on web (react-native-web) unknown style keys are
 * forwarded to the DOM, so these render as real CSS. Gated behind the web branch
 * so they never reach native.
 */
interface WebBackdropStyle extends ViewStyle {
    backdropFilter?: string;
    WebkitBackdropFilter?: string;
}

const SPRING_CONFIG = {
    damping: 20,
    stiffness: 200,
    mass: 0.5,
};

const TAB_COUNT = 5;
const ICON_SIZE = 22;

/** Height (px) of the floating bar pill. */
const BOTTOM_BAR_HEIGHT = 56;
/** Gap (px) between the floating bar and the viewport bottom (matches `web:bottom-3` / native `bottom: 12`). */
const BOTTOM_BAR_OFFSET = 12;

/**
 * Vertical space (px) the floating bar occupies above the (safe-area) viewport
 * bottom — the pill height + its bottom gap + a small breathing margin so the
 * last scrollable item clears the bar instead of sitting flush against it. The
 * mobile-web shell reserves this much `paddingBottom` (plus the safe-area inset)
 * below the document-scroll content so nothing hides BEHIND the fixed bar.
 */
export const BOTTOM_BAR_RESERVED_SPACE = BOTTOM_BAR_HEIGHT + BOTTOM_BAR_OFFSET + BOTTOM_BAR_OFFSET;

// Distance (px) the bar slides downward when fully hidden — enough to clear the
// bar height + bottom offset + its shadow so nothing peeks above the edge.
const BOTTOM_BAR_OFFSCREEN_TRAVEL = 100;
const tabStyle = {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    height: '100%' as const,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' as any } : {}),
};

export const BottomBar = () => {
    const router = useRouter();
    const pathname = usePathname();
    const { showBottomSheet, signIn, user, isAuthenticated } = useAuth();
    const theme = useTheme();
    const haptic = useHaptics();
    const { triggerHomeRefresh } = useHomeRefresh();
    const { t } = useTranslation();
    // Shared auto-hide signal (0 = visible, 1 = hidden). The FAB reads the same
    // value so it slides away in lock-step with this bar. Pinned to 0 on /videos
    // (the provider disables auto-hide there).
    const hidden = useBottomBarHidden();

    // The Reels (/videos) screen floats this bar over dark video content, so it
    // always renders against a forced-dark surface regardless of the app theme.
    // Everywhere else the bar derives its colors from the Bloom theme.
    const isVideosScreen = pathname === '/videos';

    // Animated indicator
    const tabWidth = useSharedValue(0);
    const indicatorX = useSharedValue(0);

    const activeIndex = pathname === '/' ? 0
        : pathname === '/videos' ? 1
        : pathname === '/compose' ? 2
        : pathname === '/notifications' ? 3
        : pathname.startsWith('/@') ? 4
        : -1;

    const prevActiveIndexRef = useRef(activeIndex);

    const onBarLayout = useCallback((e: LayoutChangeEvent) => {
        const width = e.nativeEvent.layout.width;
        tabWidth.value = width / TAB_COUNT;
        if (activeIndex >= 0) {
            indicatorX.value = withSpring(
                (width / TAB_COUNT) * activeIndex,
                SPRING_CONFIG,
            );
        }
    }, [activeIndex]);

    // Animate indicator when active tab changes (computed during render)
    if (prevActiveIndexRef.current !== activeIndex) {
        prevActiveIndexRef.current = activeIndex;
        if (tabWidth.value > 0 && activeIndex >= 0) {
            indicatorX.value = withSpring(
                tabWidth.value * activeIndex,
                SPRING_CONFIG,
            );
        }
    }

    // Slide the bar down by its full off-screen travel and fade as `hidden`
    // animates 0 → 1. The FAB applies the same `hidden` value to its own travel.
    const bottomBarAnimatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: hidden.value * BOTTOM_BAR_OFFSCREEN_TRAVEL }],
        opacity: 1 - hidden.value,
    }));

    // Position/size are animated; the fill color is the theme primary at ~10%
    // applied via the `bg-primary/10` NativeWind class on the indicator view so
    // it stays reactive to the Bloom preset/mode.
    const indicatorStyle = useAnimatedStyle(() => ({
        position: 'absolute' as const,
        top: 4,
        bottom: 4,
        width: tabWidth.value ? tabWidth.value - 8 : 0,
        left: indicatorX.value + 4,
        borderRadius: 22,
    }));

    // Tab-root switch. With the (app) center now a Stack, `navigate` pops to the
    // existing instance of the target tab instead of stacking a new copy, so the
    // bottom-bar tabs never grow the stack or leave duplicate Home entries.
    const handlePress = useCallback((route: Href) => {
        haptic('Light');
        router.navigate(route);
    }, [haptic, router]);

    const handleHomePress = useCallback(() => {
        haptic('Light');
        if (pathname === '/') {
            triggerHomeRefresh();
        } else {
            router.navigate('/');
        }
    }, [haptic, pathname, triggerHomeRefresh, router]);

    // Layout + shadow only. The border and background colors are driven by
    // NativeWind theme classes (`border-border`, `bg-card/80`) so they stay
    // reactive to the Bloom preset/mode; on the Reels screen they are overridden
    // inline with the forced-dark palette. `colors.shadow` is already a valid
    // `rgba(...)` string from the Bloom theme (no NativeWind equivalent).
    //
    // POSITIONING: on NATIVE the bar pins via the inline `position: 'absolute'`
    // + inset values below. On WEB the app uses a DOCUMENT-scroll model (the
    // window is the scroller), so `position: absolute` would resolve against the
    // tall document's containing block and scroll out of view. WEB therefore
    // pins to the viewport via the `web:fixed web:inset-x-4 web:bottom-3`
    // NativeWind classes on the container (12px bottom / 16px sides) — no inline
    // `position: 'fixed'` cast, mirroring ConnectionStatus / the sticky overlays.
    const containerStyle = useMemo<ViewStyle>(() => ({
        height: BOTTOM_BAR_HEIGHT,
        borderRadius: 28,
        overflow: 'hidden',
        zIndex: 1000,
        ...(isVideosScreen ? { borderColor: VIDEOS_DARK_PALETTE.border } : {}),
        ...(Platform.OS === 'web' ? {
            boxShadow: `0 2px 16px ${theme.colors.shadow}`,
        } : {
            position: 'absolute',
            bottom: BOTTOM_BAR_OFFSET,
            left: 16,
            right: 16,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.15,
            shadowRadius: 12,
            elevation: 8,
        }),
    }), [isVideosScreen, theme.colors.shadow]);

    const handlePressVideos = useCallback(() => handlePress('/videos'), [handlePress]);
    // Compose is a modal-presented detail, not a tab root, so it must `push`
    // (over whatever screen is focused) rather than `navigate`. It does NOT go
    // through `handlePress`, which now uses navigate semantics for tab roots.
    const handlePressCompose = useCallback(() => {
        haptic('Light');
        router.push('/compose');
    }, [haptic, router]);
    const handlePressNotifications = useCallback(() => handlePress('/notifications'), [handlePress]);
    const handlePressProfile = useCallback(() => {
        if (isAuthenticated && user?.username) {
            handlePress(`/@${user.username}`);
        } else {
            signIn().catch(() => {});
        }
    }, [isAuthenticated, user?.username, handlePress, signIn]);
    const handleLongPressProfile = useCallback(() => {
        haptic('Heavy');
        showBottomSheet?.('ManageAccount');
    }, [haptic, showBottomSheet]);

    const tabs = useMemo(() => [
        {
            onPress: handleHomePress,
            label: t('bottomBar.home'),
            isActive: pathname === '/',
            icon: pathname === '/'
                ? <HomeActive size={ICON_SIZE} className="text-primary" />
                : <Home size={ICON_SIZE} className="text-muted-foreground" />,
        },
        {
            onPress: handlePressVideos,
            label: t('bottomBar.videos'),
            isActive: pathname === '/videos',
            icon: pathname === '/videos'
                ? <VideoActive size={ICON_SIZE} className="text-primary" />
                : <Video size={ICON_SIZE} className="text-muted-foreground" />,
        },
        {
            onPress: handlePressCompose,
            label: t('bottomBar.compose'),
            isActive: pathname === '/compose',
            icon: pathname === '/compose'
                ? <ComposeIIconActive size={ICON_SIZE} className="text-primary" />
                : <ComposeIcon size={ICON_SIZE} className="text-muted-foreground" />,
        },
        {
            onPress: handlePressNotifications,
            label: t('bottomBar.notifications'),
            isActive: pathname === '/notifications',
            icon: pathname === '/notifications'
                ? <BellActive size={ICON_SIZE} className="text-primary" />
                : <Bell size={ICON_SIZE} className="text-muted-foreground" />,
        },
        {
            onPress: handlePressProfile,
            onLongPress: handleLongPressProfile,
            label: t('bottomBar.profile'),
            isActive: pathname.startsWith('/@'),
            icon: <Avatar size={ICON_SIZE + 4} source={user?.avatar} />,
        },
    ], [
        handleHomePress, handlePressVideos, handlePressCompose, handlePressNotifications,
        handlePressProfile, handleLongPressProfile, t, pathname, user?.avatar,
    ]);

    const innerContent = (
        <>
            <Animated.View className="bg-primary/10" style={indicatorStyle} />
            {tabs.map((tab, index) => (
                <Pressable
                    key={index}
                    onPress={tab.onPress}
                    onLongPress={tab.onLongPress}
                    style={tabStyle}
                    accessibilityRole="tab"
                    accessibilityLabel={tab.label}
                    accessibilityState={{ selected: tab.isActive }}
                >
                    {tab.icon}
                </Pressable>
            ))}
        </>
    );

    // Web frosted-glass surface: a subtle CSS backdrop blur over the translucent
    // `bg-card/80` token (applied via NativeWind className below) so the content
    // behind the bar blurs through, mirroring the native BlurView. The backdrop
    // props are web-only CSS, gated behind the `Platform.OS === 'web'` branch.
    const webContainerStyle = useMemo<WebBackdropStyle>(() => ({
        ...containerStyle,
        ...(isVideosScreen ? { backgroundColor: VIDEOS_DARK_PALETTE.cardTranslucent } : {}),
        backdropFilter: `blur(${WEB_BLUR_RADIUS})`,
        WebkitBackdropFilter: `blur(${WEB_BLUR_RADIUS})`,
        flexDirection: 'row',
        alignItems: 'center',
    }), [containerStyle, isVideosScreen]);

    if (Platform.OS === 'web') {
        // The `web:fixed web:inset-x-4 web:bottom-3` classes pin the bar to the
        // VIEWPORT bottom (12px up, 16px sides) in the document-scroll model so it
        // stays visible while the document scrolls. They live on the SAME element
        // that carries the slide/opacity transform: a transformed ancestor becomes
        // the containing block for any `position: fixed` descendant (it would trap
        // it), so the fixed element MUST be the transformed one — the translateY
        // then just offsets the already-fixed bar for the auto-hide slide.
        return (
            <Animated.View
                className="web:fixed web:inset-x-4 web:bottom-3 web:z-[1000]"
                style={bottomBarAnimatedStyle}
            >
                <View
                    className={cn('border', isVideosScreen ? undefined : 'border-border bg-card/80')}
                    style={webContainerStyle}
                    onLayout={onBarLayout}
                >
                    {innerContent}
                </View>
            </Animated.View>
        );
    }

    return (
        <Animated.View style={bottomBarAnimatedStyle}>
            <View
                className={cn('border', isVideosScreen ? undefined : 'border-border')}
                style={containerStyle}
                onLayout={onBarLayout}
            >
                <BlurView
                    intensity={80}
                    tint={isVideosScreen || theme.isDark ? 'dark' : 'light'}
                    experimentalBlurMethod="dimezisBlurView"
                    style={styles.blurContent}
                >
                    {innerContent}
                </BlurView>
            </View>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    blurContent: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
    },
});
