import { StyleSheet, View, Pressable, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';

export const BottomBar = () => {
    const router = useRouter();
    const [activeRoute, setActiveRoute] = React.useState('/');

    interface HandlePressProps {
        route: string;
    }

    const handlePress = (route: '/' | '/compose' | '/explore' | '/notifications' | '/messages') => {
        setActiveRoute(route);
        router.push(route);
    };

    return (
        <View style={styles.bottomBar}>
            <Pressable onPress={() => handlePress('/')} style={[styles.tab, activeRoute === '/' && styles.active]}>
                <Ionicons name="home" size={28} color={activeRoute === '/' ? '#6200ee' : '#757575'} />
            </Pressable>
            <Pressable onPress={() => handlePress('/explore')} style={[styles.tab, activeRoute === '/explore' && styles.active]}>
                <Ionicons name="search" size={28} color={activeRoute === '/explore' ? '#6200ee' : '#757575'} />
            </Pressable>
            <Pressable onPress={() => handlePress('/notifications')} style={[styles.tab, activeRoute === '/notifications' && styles.active]}>
                <Ionicons name="notifications" size={28} color={activeRoute === '/notifications' ? '#6200ee' : '#757575'} />
            </Pressable>
            <Pressable onPress={() => handlePress('/messages')} style={[styles.tab, activeRoute === '/messages' && styles.active]}>
                <Ionicons name="mail" size={28} color={activeRoute === '/messages' ? '#6200ee' : '#757575'} />
            </Pressable>
        </View>
    );
};

const styles = StyleSheet.create({
    bottomBar: {
        height: 60,
        backgroundColor: '#ffffff',
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        borderTopWidth: 1,
        borderTopColor: '#eeeeee',
        elevation: 8,
    },
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