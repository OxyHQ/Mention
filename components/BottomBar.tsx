import { StyleSheet, View, Pressable, Text, ViewStyle, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, usePathname } from 'expo-router';
import React from 'react';
import { Home, HomeActive } from '@/assets/icons/home-icon';
import { Search, SearchActive } from '@/assets/icons/search-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { Chat, ChatActive } from '@/assets/icons/chat-icon';
import { Video, VideoActive } from '@/assets/icons/video-icon';

export const BottomBar = () => {
    const router = useRouter();
    const [activeRoute, setActiveRoute] = React.useState('/');
    const pathname = usePathname();

    interface HandlePressProps {
        route: string;
    }

    const handlePress = (route: '/' | '/compose' | '/explore' | '/notifications' | '/chat' | '/videos') => {
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
            borderTopWidth: pathname === '/videos' ? 0 : 1,
            borderTopColor: pathname === '/videos' ? 'transparent' : '#eeeeee',
            elevation: pathname === '/videos' ? 0 : 8,
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
                {activeRoute === '/' ? <HomeActive size={28} /> : <Home size={28} />}
            </Pressable>
            <Pressable onPress={() => handlePress('/explore')} style={[styles.tab, activeRoute === '/explore' && styles.active]}>
                {activeRoute === '/explore' ? <SearchActive size={28} /> : <Search size={28} />}
            </Pressable>
            <Pressable onPress={() => handlePress('/videos')} style={[styles.tab, activeRoute === '/videos' && styles.active]}>
                {activeRoute === '/videos' ? <VideoActive size={28} /> : <Video size={28} />}
            </Pressable>
            <Pressable onPress={() => handlePress('/notifications')} style={[styles.tab, activeRoute === '/notifications' && styles.active]}>
                {activeRoute === '/notifications' ? <BellActive size={28} /> : <Bell size={28} />}
            </Pressable>
            <Pressable onPress={() => handlePress('/chat')} style={[styles.tab, activeRoute === '/messages' && styles.active]}>
                {activeRoute === '/chat' ? <ChatActive size={28} /> : <Chat size={28} />}
            </Pressable>
        </View>
    );
};