import { StyleSheet, View, Pressable, ViewStyle, Platform, Vibration } from 'react-native';
import { Home, HomeActive, Search, SearchActive, ComposeIcon, ComposeIIconActive, BellActive, Bell } from '@/assets/icons';
import { colors } from '@/styles/colors';
import { useRouter, usePathname } from 'expo-router';
import React from 'react';
import Avatar from './Avatar';
import { useOxy } from '@oxyhq/services';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const BottomBar = () => {
    const router = useRouter();
    const pathname = usePathname();
    const { showBottomSheet, user, isAuthenticated, oxyServices } = useOxy();
    const insets = useSafeAreaInsets();

    const handlePress = (route: string) => {
        router.push(route);
    };

    const styles = StyleSheet.create({
        bottomBar: {
            width: '100%',
            height: 60 + insets.bottom,
            backgroundColor: colors.primaryLight,
            flexDirection: 'row',
            justifyContent: 'space-around',
            alignItems: 'center',
            borderTopWidth: 1,
            borderTopColor: colors.COLOR_BLACK_LIGHT_6,
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
            <Pressable onPress={() => handlePress('/')} style={[styles.tab, pathname === '/' && styles.active]}>
                {pathname === '/' ? (
                    <HomeActive size={28} color={colors.primaryColor} />
                ) : (
                    <Home size={28} color={colors.COLOR_BLACK} />
                )}
            </Pressable>
            <Pressable onPress={() => handlePress('/explore')} style={[styles.tab, pathname === '/explore' && styles.active]}>
                {pathname === '/explore' ? (
                    <SearchActive size={28} color={colors.primaryColor} />
                ) : (
                    <Search size={28} color={colors.COLOR_BLACK} />
                )}
            </Pressable>
            <Pressable onPress={() => handlePress('/compose')} style={[styles.tab, pathname === '/compose' && styles.active]}>
                {pathname === '/compose' ? (
                    <ComposeIIconActive size={28} color={colors.primaryColor} />
                ) : (
                    <ComposeIcon size={28} color={colors.COLOR_BLACK} />
                )}
            </Pressable>
            <Pressable onPress={() => handlePress('/notifications')} style={[styles.tab, pathname === '/notifications' && styles.active]}>
                {pathname === '/notifications' ? (
                    <BellActive size={28} color={colors.primaryColor} />
                ) : (
                    <Bell size={28} color={colors.COLOR_BLACK} />
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