import { View, Pressable, Platform, LayoutChangeEvent, StyleSheet } from 'react-native';
import { Home, HomeActive, Video, VideoActive, ComposeIcon, ComposeIIconActive, BellActive, Bell } from '@/assets/icons';
import { useRouter, usePathname, type Href } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Avatar } from '@oxyhq/bloom/avatar';

import { useAuth } from '@oxyhq/services';
import { useTheme } from '@oxyhq/bloom/theme';
import { useHaptics } from '@/hooks/useHaptics';
import { useHomeRefresh } from '@/context/HomeRefreshContext';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { useTranslation } from 'react-i18next';
// Dark-mode override palette for videos screen
const VIDEOS_DARK_PALETTE = {
    card: '#003038',
    border: '#555555',
    text: '#AAAAAA',
    textSecondary: '#888888',
};
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';

const SPRING_CONFIG = {
    damping: 20,
    stiffness: 200,
    mass: 0.5,
};

const TAB_COUNT = 5;
const ICON_SIZE = 22;
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
    const { scrollY } = useLayoutScroll();
    const bottomBarTranslateY = useSharedValue(0);
    const bottomBarOpacity = useSharedValue(1);

    // Force dark theme on videos screen
    const isVideosScreen = pathname === '/videos';
    const effectiveTheme = useMemo(() => isVideosScreen ? {
        ...theme,
        isDark: true,
        colors: {
            ...theme.colors,
            card: VIDEOS_DARK_PALETTE.card,
            border: VIDEOS_DARK_PALETTE.border,
            text: VIDEOS_DARK_PALETTE.text,
            textSecondary: VIDEOS_DARK_PALETTE.textSecondary,
            primary: theme.colors.primary,
        }
    } : theme, [isVideosScreen, theme]);

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

    // Track scroll direction and animate bottom bar
    useEffect(() => {
        let isScrollingDown = false;
        let lastKnownScrollY = 0;

        const listenerId = scrollY.addListener(({ value }) => {
            const currentScrollY = typeof value === 'number' ? value : 0;
            const scrollDelta = currentScrollY - lastKnownScrollY;

            if (Math.abs(scrollDelta) > 1) {
                isScrollingDown = scrollDelta > 0;
            }

            if (currentScrollY > 50) {
                if (isScrollingDown) {
                    bottomBarTranslateY.value = withTiming(100, { duration: 200 });
                    bottomBarOpacity.value = withTiming(0, { duration: 200 });
                } else {
                    bottomBarTranslateY.value = withTiming(0, { duration: 200 });
                    bottomBarOpacity.value = withTiming(1, { duration: 200 });
                }
            } else {
                bottomBarTranslateY.value = withTiming(0, { duration: 200 });
                bottomBarOpacity.value = withTiming(1, { duration: 200 });
            }

            lastKnownScrollY = currentScrollY;
        });

        return () => {
            scrollY.removeListener(listenerId);
        };
    }, [scrollY, bottomBarTranslateY, bottomBarOpacity]);

    const bottomBarAnimatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: bottomBarTranslateY.value }],
        opacity: bottomBarOpacity.value,
    }));

    const indicatorStyle = useAnimatedStyle(() => ({
        position: 'absolute' as const,
        top: 4,
        bottom: 4,
        width: tabWidth.value ? tabWidth.value - 8 : 0,
        left: indicatorX.value + 4,
        borderRadius: 22,
        backgroundColor: `${effectiveTheme.colors.primary}1A`,
    }));

    const handlePress = useCallback((route: Href) => {
        haptic('Light');
        router.push(route);
    }, [haptic, router]);

    const handleHomePress = useCallback(() => {
        haptic('Light');
        if (pathname === '/') {
            triggerHomeRefresh();
        } else {
            router.push('/');
        }
    }, [haptic, pathname, triggerHomeRefresh, router]);

    const containerStyle = useMemo(() => ({
        position: 'absolute' as const,
        bottom: 12,
        left: 16,
        right: 16,
        height: 56,
        borderRadius: 28,
        borderWidth: 1,
        borderColor: effectiveTheme.colors.border,
        overflow: 'hidden' as const,
        zIndex: 1000,
        ...(Platform.OS === 'web' ? {
            boxShadow: `0 2px 16px ${effectiveTheme.colors.shadow}`,
        } : {
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.15,
            shadowRadius: 12,
            elevation: 8,
        }),
    }), [effectiveTheme.colors.border, effectiveTheme.colors.shadow]);

    const handlePressVideos = useCallback(() => handlePress('/videos'), [handlePress]);
    const handlePressCompose = useCallback(() => handlePress('/compose'), [handlePress]);
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
        showBottomSheet?.('AccountCenter');
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
            <Animated.View style={indicatorStyle} />
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

    const webContainerStyle = useMemo(() => ({
        ...containerStyle,
        backgroundColor: `${effectiveTheme.colors.card}CC`,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
    }), [containerStyle, effectiveTheme.colors.card]);

    if (Platform.OS === 'web') {
        return (
            <Animated.View style={bottomBarAnimatedStyle}>
                <View
                    style={webContainerStyle as any}
                    onLayout={onBarLayout}
                >
                    {innerContent}
                </View>
            </Animated.View>
        );
    }

    return (
        <Animated.View style={bottomBarAnimatedStyle}>
            <View style={containerStyle} onLayout={onBarLayout}>
                <BlurView
                    intensity={80}
                    tint={effectiveTheme.isDark ? 'dark' : 'light'}
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