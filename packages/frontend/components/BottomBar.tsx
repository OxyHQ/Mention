import { Ionicons } from '@expo/vector-icons';
import { useOxy } from '@oxyhq/services';
import { usePathname, useRouter } from 'expo-router';
import React from 'react';
import { Platform, Pressable, StyleSheet, View, ViewStyle } from 'react-native';
import Avatar from './Avatar';

export const BottomBar = () => {
    const router = useRouter();
    const [activeRoute, setActiveRoute] = React.useState('/');
    const pathname = usePathname();
    const { showBottomSheet, hideBottomSheet, user, isAuthenticated } = useOxy();

    const handlePress = (route: '/' | '/properties' | '/saved' | '/contracts' | '/profile') => {
        setActiveRoute(route);
        router.push(route);
    };

    const styles = StyleSheet.create({
        bottomBar: {
            width: '100%',
            height: 60,
            backgroundColor: '#ffffff',
            flexDirection: 'row',
            justifyContent: 'space-around',
            alignItems: 'center',
            borderTopWidth: 1,
            borderTopColor: '#eeeeee',
            elevation: 8,
            ...Platform.select({
                web: {
                    position: 'sticky',
                    bottom: 0,
                    left: 0,
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
            <Pressable onPress={() => handlePress('/')} style={[styles.tab, activeRoute === '/' && styles.active]}>
                <Ionicons name={activeRoute === '/' ? "home" : "home-outline"} size={28} color={activeRoute === '/' ? "#4E67EB" : "#000"} />
            </Pressable>
            <Pressable onPress={() => handlePress('/properties')} style={[styles.tab, activeRoute === '/properties' && styles.active]}>
                <Ionicons name={activeRoute === '/properties' ? "search" : "search-outline"} size={28} color={activeRoute === '/properties' ? "#4E67EB" : "#000"} />
            </Pressable>
            <Pressable onPress={() => handlePress('/saved')} style={[styles.tab, activeRoute === '/saved' && styles.active]}>
                <Ionicons name={activeRoute === '/saved' ? "bookmark" : "bookmark-outline"} size={28} color={activeRoute === '/saved' ? "#4E67EB" : "#000"} />
            </Pressable>
            <Pressable onPress={() => handlePress('/contracts')} style={[styles.tab, activeRoute === '/contracts' && styles.active]}>
                <Ionicons name={activeRoute === '/contracts' ? "document-text" : "document-text-outline"} size={28} color={activeRoute === '/contracts' ? "#4E67EB" : "#000"} />
            </Pressable>
            <View style={styles.tab}>
                <Avatar
                  onPress={() => {
                    if (isAuthenticated) {
                      handlePress('/profile');
                    } else {
                      showBottomSheet?.('SignIn');
                    }
                  }}
                  onLongPress={() => {
                    showBottomSheet?.('AccountCenter');
                  }}
                />
            </View>
        </View>
    );
};