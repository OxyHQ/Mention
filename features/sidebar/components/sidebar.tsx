import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet, Dimensions, ScrollView } from 'react-native';
import { Ionicons } from "@expo/vector-icons";
import MenuItem from './MenuItem';
import AccountSwitcher from './AccountSwitcher';
import { Logo } from '@/components/Logo';
import { useRouter } from 'expo-router';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const Sidebar = () => {
    const [isWide, setIsWide] = useState(SCREEN_WIDTH > 900);
    const router = useRouter();

    useEffect(() => {
        const updateLayout = () => {
            setIsWide(Dimensions.get('window').width > 900);
        };

        const subscription = Dimensions.addEventListener('change', updateLayout);
        return () => {
            subscription?.remove();
        };
    }, []);

    const menuItems: { icon: React.ComponentProps<typeof Ionicons>['name'], label: string, route: "/" | "/explore" | "/notifications" | "/messages" | "/bookmarks" | "/lists" | "/profile" | "/more" | "/settings" }[] = [
        { icon: 'home', label: 'Home', route: '/' },
        { icon: 'search', label: 'Explore', route: '/explore' },
        { icon: 'notifications', label: 'Notifications', route: '/notifications' },
        { icon: 'mail', label: 'Messages', route: '/messages' },
        { icon: 'bookmark', label: 'Bookmarks', route: '/bookmarks' },
        { icon: 'list', label: 'Lists', route: '/lists' },
        { icon: 'person', label: 'Profile', route: '/profile' },
        { icon: 'ellipsis-horizontal', label: 'More', route: '/more' },
        { icon: 'settings', label: 'Settings', route: '/settings' },
    ];

    return (
        <View style={[styles.container, isWide && styles.wideContainer]}>
            <ScrollView style={styles.scrollView}>
                <Logo />
                {menuItems.map((item, index) => (
                    <MenuItem
                        key={index}
                        icon={item.icon}
                        label={item.label}
                        expanded={isWide}
                        route={item.route}
                    />
                ))}
                <TouchableOpacity style={[styles.tweetButton, isWide && styles.wideTweetButton]}>
                    <Ionicons name="create" size={24} color="white" />
                    {isWide && <Text style={styles.tweetButtonText}>Tweet</Text>}
                </TouchableOpacity>
            </ScrollView>
            <AccountSwitcher expanded={isWide} />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        paddingTop: 10,
        paddingHorizontal: 12,
    },
    wideContainer: {
        width: "100%",
        maxWidth: 275,
    },
    scrollView: {
        flex: 1,
    },
    tweetButton: {
        backgroundColor: '#1da1f2',
        borderRadius: 50,
        width: 50,
        height: 50,
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 15,
        marginBottom: 15,
        alignSelf: 'center',
    },
    wideTweetButton: {
        width: '100%',
        flexDirection: 'row',
    },
    tweetButtonText: {
        color: 'white',
        marginLeft: 10,
        fontWeight: 'bold',
    },
});

export default Sidebar;

