import { StyleSheet, View, Pressable, Text, ViewStyle, Platform } from 'react-native';
import { Home, HomeActive, Search, SearchActive, ComposeIcon, ComposeIIconActive, BellActive, Bell } from '@/assets/icons';
import { useRouter, usePathname } from 'expo-router';
import React from 'react';
import Avatar from './Avatar';
import { useOxy } from '@oxyhq/services';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const BottomBar = () => {
    const router = useRouter();
    const pathname = usePathname();
    const { showBottomSheet, user, isAuthenticated } = useOxy();
    const insets = useSafeAreaInsets();

    const handlePress = (route: string) => {
        router.push(route);
    };

    const styles = StyleSheet.create({
        bottomBar: {
            width: '100%',
            height: 60 + insets.bottom,
            backgroundColor: '#ffffff',
            flexDirection: 'row',
            justifyContent: 'space-around',
            alignItems: 'center',
            borderTopWidth: 1,
            borderTopColor: '#eeeeee',
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
                    <HomeActive size={28} color="#4E67EB" />
                ) : (
                    <Home size={28} color="#000" />
                )}
            </Pressable>
            <Pressable onPress={() => handlePress('/search')} style={[styles.tab, pathname === '/search' && styles.active]}>
                {pathname === '/search' ? (
                    <SearchActive size={28} color="#4E67EB" />
                ) : (
                    <Search size={28} color="#000" />
                )}
            </Pressable>
            <Pressable onPress={() => handlePress('/compose')} style={[styles.tab, pathname === '/compose' && styles.active]}>
                {pathname === '/compose' ? (
                    <ComposeIIconActive size={28} color="#4E67EB" />
                ) : (
                    <ComposeIcon size={28} color="#000" />
                )}
            </Pressable>
            <Pressable onPress={() => handlePress('/notifications')} style={[styles.tab, pathname === '/notifications' && styles.active]}>
                {pathname === '/notifications' ? (
                    <BellActive size={28} color="#4E67EB" />
                ) : (
                    <Bell size={28} color="#000" />
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
                    showBottomSheet?.('AccountCenter');
                }}
            >
                <Avatar />
            </Pressable>
        </View>
    );
};