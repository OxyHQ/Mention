import { StyleSheet, View, Pressable, ViewStyle, Platform, Vibration } from 'react-native';
import { Home, HomeActive, Search, SearchActive, ComposeIcon, ComposeIIconActive, BellActive, Bell } from '@/assets/icons';
import { useRouter, usePathname } from 'expo-router';
import React, { useRef } from 'react';
import Avatar from './Avatar';
import { useOxy } from '@oxyhq/services';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { useHomeRefresh } from '@/context/HomeRefreshContext';
import { colors as baseColors } from '@/styles/colors';

export const BottomBar = () => {
    const router = useRouter();
    const pathname = usePathname();
    const { showBottomSheet, user, isAuthenticated, oxyServices } = useOxy();
    const insets = useSafeAreaInsets();
    const theme = useTheme();
    const { triggerHomeRefresh } = useHomeRefresh();
    
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

    const styles = StyleSheet.create({
        bottomBar: {
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
            ...Platform.select({
                web: {
                    position: 'sticky',
                    bottom: 0,
                    left: 0,
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
        <View style={styles.bottomBar}>
            <Pressable onPress={handleHomePress} style={[styles.tab, pathname === '/' && styles.active]}>
                {pathname === '/' ? (
                    <HomeActive size={28} color={effectiveTheme.colors.primary} />
                ) : (
                    <Home size={28} color={effectiveTheme.colors.text} />
                )}
            </Pressable>
            <Pressable onPress={() => handlePress('/explore')} style={[styles.tab, pathname === '/explore' && styles.active]}>
                {pathname === '/explore' ? (
                    <SearchActive size={28} color={effectiveTheme.colors.primary} />
                ) : (
                    <Search size={28} color={effectiveTheme.colors.text} />
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
        </View>
    );
};