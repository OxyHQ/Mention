import { View, Pressable, Platform, Vibration, LayoutChangeEvent } from 'react-native';
import { Home, HomeActive, Video, VideoActive, ComposeIcon, ComposeIIconActive, BellActive, Bell } from '@/assets/icons';
import { useRouter, usePathname } from 'expo-router';
import React, { useCallback, useEffect } from 'react';
import Avatar from './Avatar';
import { useAuth } from '@oxyhq/services';
import { useTheme } from '@/hooks/useTheme';
import { useHomeRefresh } from '@/context/HomeRefreshContext';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { colors as baseColors } from '@/styles/colors';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';

const SPRING_CONFIG = {
    damping: 20,
    stiffness: 200,
    mass: 0.5,
};

const TAB_COUNT = 5;
const ICON_SIZE = 22;

export const BottomBar = () => {
    const router = useRouter();
    const pathname = usePathname();
    const { showBottomSheet, signIn, user, isAuthenticated } = useAuth();
    const theme = useTheme();
    const { triggerHomeRefresh } = useHomeRefresh();
    const { scrollY } = useLayoutScroll();
    const bottomBarTranslateY = useSharedValue(0);
    const bottomBarOpacity = useSharedValue(1);

    // Force dark theme on videos screen
    const isVideosScreen = pathname === '/videos';
    const effectiveTheme = isVideosScreen ? {
        ...theme,
        isDark: true,
        colors: {
            ...theme.colors,
            card: baseColors.primaryDark_1,
            border: baseColors.COLOR_BLACK_LIGHT_3,
            text: baseColors.COLOR_BLACK_LIGHT_6,
            textSecondary: baseColors.COLOR_BLACK_LIGHT_5,
            primary: theme.colors.primary,
        }
    } : theme;

    // Animated indicator
    const tabWidth = useSharedValue(0);
    const indicatorX = useSharedValue(0);

    const activeIndex = pathname === '/' ? 0
        : pathname === '/videos' ? 1
        : pathname === '/compose' ? 2
        : pathname === '/notifications' ? 3
        : pathname.startsWith('/@') ? 4
        : -1;

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

    useEffect(() => {
        if (tabWidth.value > 0 && activeIndex >= 0) {
            indicatorX.value = withSpring(
                tabWidth.value * activeIndex,
                SPRING_CONFIG,
            );
        }
    }, [activeIndex]);

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

    const handlePress = (route: string) => {
        router.push(route);
    };

    const handleHomePress = () => {
        if (pathname === '/') {
            triggerHomeRefresh();
        } else {
            handlePress('/');
        }
    };

    const containerStyle = {
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
    };

    const tabStyle = {
        flex: 1,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        height: '100%' as const,
        ...(Platform.OS === 'web' ? { cursor: 'pointer' as any } : {}),
    };

    const tabs = [
        {
            onPress: handleHomePress,
            icon: pathname === '/'
                ? <HomeActive size={ICON_SIZE} color={effectiveTheme.colors.primary} />
                : <Home size={ICON_SIZE} color={effectiveTheme.colors.textSecondary} />,
        },
        {
            onPress: () => handlePress('/videos'),
            icon: pathname === '/videos'
                ? <VideoActive size={ICON_SIZE} color={effectiveTheme.colors.primary} />
                : <Video size={ICON_SIZE} color={effectiveTheme.colors.textSecondary} />,
        },
        {
            onPress: () => handlePress('/compose'),
            icon: pathname === '/compose'
                ? <ComposeIIconActive size={ICON_SIZE} color={effectiveTheme.colors.primary} />
                : <ComposeIcon size={ICON_SIZE} color={effectiveTheme.colors.textSecondary} />,
        },
        {
            onPress: () => handlePress('/notifications'),
            icon: pathname === '/notifications'
                ? <BellActive size={ICON_SIZE} color={effectiveTheme.colors.primary} />
                : <Bell size={ICON_SIZE} color={effectiveTheme.colors.textSecondary} />,
        },
        {
            onPress: () => {
                if (isAuthenticated && user?.username) {
                    handlePress(`/@${user.username}`);
                } else {
                    signIn().catch(() => {});
                }
            },
            onLongPress: () => {
                Vibration.vibrate(50);
                showBottomSheet?.('AccountCenter');
            },
            icon: <Avatar size={ICON_SIZE + 4} source={user?.avatar} />,
        },
    ];

    const innerContent = (
        <>
            <Animated.View style={indicatorStyle} />
            {tabs.map((tab, index) => (
                <Pressable
                    key={index}
                    onPress={tab.onPress}
                    onLongPress={tab.onLongPress}
                    style={tabStyle}
                >
                    {tab.icon}
                </Pressable>
            ))}
        </>
    );

    if (Platform.OS === 'web') {
        return (
            <Animated.View style={bottomBarAnimatedStyle}>
                <View
                    style={{
                        ...containerStyle,
                        backgroundColor: `${effectiveTheme.colors.card}CC`,
                        backdropFilter: 'blur(20px)',
                        WebkitBackdropFilter: 'blur(20px)',
                        flexDirection: 'row',
                        alignItems: 'center',
                    } as any}
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
                    style={{
                        flex: 1,
                        flexDirection: 'row',
                        alignItems: 'center',
                    }}
                >
                    {innerContent}
                </BlurView>
            </View>
        </Animated.View>
    );
};