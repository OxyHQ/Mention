import { StyleSheet, View, Pressable, ViewStyle, Platform, Vibration } from 'react-native';
import { Home, HomeActive, Video, VideoActive, ComposeIcon, ComposeIIconActive, BellActive, Bell } from '@/assets/icons';
import { useRouter, usePathname } from 'expo-router';
import React, { useRef, useEffect, useMemo } from 'react';
import Avatar from './Avatar';
import { useAuth } from '@oxyhq/services';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { useHomeRefresh } from '@/context/HomeRefreshContext';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { colors as baseColors } from '@/styles/colors';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

export const BottomBar = () => {
    const router = useRouter();
    const pathname = usePathname();
    const { showBottomSheet, user, isAuthenticated, oxyServices } = useAuth();
    const insets = useSafeAreaInsets();
    const theme = useTheme();
    const { triggerHomeRefresh } = useHomeRefresh();
    const { scrollY } = useLayoutScroll();
    const bottomBarTranslateY = useSharedValue(0);
    const bottomBarOpacity = useSharedValue(1);
    const bottomBarHeight = 60 + insets.bottom;
    
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
            primary: theme.colors.primary,
        }
    } : theme;

    const handlePress = (route: string) => {
        router.push(route);
    };

    const handleHomePress = () => {
        // If already on home page - scroll to top and refresh
        if (pathname === '/') {
            triggerHomeRefresh();
        } else {
            // Not on home - navigate to home
            handlePress('/');
        }
    };

    // Track scroll direction and animate bottom bar
    useEffect(() => {
        let isScrollingDown = false;
        let lastKnownScrollY = 0;
        
        const listenerId = scrollY.addListener(({ value }) => {
            const currentScrollY = typeof value === 'number' ? value : 0;
            const scrollDelta = currentScrollY - lastKnownScrollY;
            
            // Determine scroll direction (only update if movement is significant)
            if (Math.abs(scrollDelta) > 1) {
                isScrollingDown = scrollDelta > 0;
            }
            
            if (currentScrollY > 50) { // Only hide after scrolling past threshold
                if (isScrollingDown) {
                    // Scrolling down - hide bottom bar with opacity
                    bottomBarTranslateY.value = withTiming(bottomBarHeight, { duration: 200 });
                    bottomBarOpacity.value = withTiming(0, { duration: 200 });
                } else {
                    // Scrolling up - show bottom bar
                    bottomBarTranslateY.value = withTiming(0, { duration: 200 });
                    bottomBarOpacity.value = withTiming(1, { duration: 200 });
                }
            } else {
                // Near top - always show bottom bar
                bottomBarTranslateY.value = withTiming(0, { duration: 200 });
                bottomBarOpacity.value = withTiming(1, { duration: 200 });
            }
            
            lastKnownScrollY = currentScrollY;
        });
        
        return () => {
            scrollY.removeListener(listenerId);
        };
    }, [scrollY, bottomBarTranslateY, bottomBarOpacity, bottomBarHeight]);

    const bottomBarAnimatedStyle = useAnimatedStyle(() => {
        return {
            transform: [{ translateY: bottomBarTranslateY.value }],
            opacity: bottomBarOpacity.value,
        };
    });

    const styles = StyleSheet.create({
        bottomBar: {
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            width: '100%',
            height: 60 + insets.bottom,
            backgroundColor: effectiveTheme.colors.card,
            flexDirection: 'row',
            justifyContent: 'space-around',
            alignItems: 'center',
            borderTopWidth: 1,
            borderTopColor: effectiveTheme.colors.border,
            elevation: 8,
            paddingBottom: insets.bottom,
            zIndex: 1000,
            ...Platform.select({
                web: {
                    position: 'fixed',
                    height: 60,
                    paddingBottom: 0,
                },
            }),
        } as ViewStyle,
        tab: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            paddingVertical: 10,
        },
        active: {
            borderRadius: 30,
        },
    });

    return (
        <Animated.View style={[styles.bottomBar, bottomBarAnimatedStyle]}>
            <Pressable onPress={handleHomePress} style={[styles.tab, pathname === '/' && styles.active]}>
                {pathname === '/' ? (
                    <HomeActive size={28} color={effectiveTheme.colors.primary} />
                ) : (
                    <Home size={28} color={effectiveTheme.colors.text} />
                )}
            </Pressable>
            <Pressable onPress={() => handlePress('/videos')} style={[styles.tab, pathname === '/videos' && styles.active]}>
                {pathname === '/videos' ? (
                    <VideoActive size={28} color={effectiveTheme.colors.primary} />
                ) : (
                    <Video size={28} color={effectiveTheme.colors.text} />
                )}
            </Pressable>
            <Pressable onPress={() => handlePress('/compose')} style={[styles.tab, pathname === '/compose' && styles.active]}>
                {pathname === '/compose' ? (
                    <ComposeIIconActive size={28} color={effectiveTheme.colors.primary} />
                ) : (
                    <ComposeIcon size={28} color={effectiveTheme.colors.text} />
                )}
            </Pressable>
            <Pressable onPress={() => handlePress('/notifications')} style={[styles.tab, pathname === '/notifications' && styles.active]}>
                {pathname === '/notifications' ? (
                    <BellActive size={28} color={effectiveTheme.colors.primary} />
                ) : (
                    <Bell size={28} color={effectiveTheme.colors.text} />
                )}
            </Pressable>
            <Pressable
                style={[styles.tab, pathname.startsWith('/@') && styles.active]}
                onPress={() => {
                    if (isAuthenticated && user?.username) {
                        handlePress(`/@${user.username}`);
                    } else {
                        showBottomSheet?.('SignIn');
                    }
                }}
                onLongPress={() => {
                    Vibration.vibrate(50);
                    showBottomSheet?.('AccountCenter');
                }}
            >
                <Avatar size={35} source={{ uri: user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') : undefined }} />
            </Pressable>
        </Animated.View>
    );
};