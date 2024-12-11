import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet, Dimensions, ScrollView } from 'react-native';
import { Ionicons } from "@expo/vector-icons";
import MenuItem from './MenuItem';
import AccountSwitcher from './AccountSwitcher';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const Sidebar = () => {
    const [isWide, setIsWide] = useState(SCREEN_WIDTH > 900);

    useEffect(() => {
        const updateLayout = () => {
            setIsWide(Dimensions.get('window').width > 900);
        };

        Dimensions.addEventListener('change', updateLayout);
        return () => {
            // Remove event listener on cleanup
            Dimensions.removeEventListener('change', updateLayout);
        };
    }, []);

    const menuItems: { icon: React.ComponentProps<typeof Ionicons>['name'], label: string }[] = [
        { icon: 'home', label: 'Home' },
        { icon: 'search', label: 'Explore' },
        { icon: 'notifications', label: 'Notifications' },
        { icon: 'mail', label: 'Messages' },
        { icon: 'bookmark', label: 'Bookmarks' },
        { icon: 'list', label: 'Lists' },
        { icon: 'person', label: 'Profile' },
        { icon: 'ellipsis-horizontal', label: 'More' },
    ];

    return (
        <View style={[styles.container, isWide && styles.wideContainer]}>
            <ScrollView style={styles.scrollView}>
                <Image
                    source={{ uri: 'https://abs.twimg.com/responsive-web/client-web/icon-ios.b1fc727a.png' }}
                    style={styles.logo}
                />
                {menuItems.map((item, index) => (
                    <MenuItem key={index} icon={item.icon} label={item.label} expanded={isWide} />
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
        width: 88,
        height: '100%',
        backgroundColor: '#ffffff',
        borderRightWidth: 1,
        borderRightColor: '#e1e8ed',
        paddingTop: 10,
        paddingHorizontal: 12,
    },
    wideContainer: {
        width: 275,
    },
    scrollView: {
        flex: 1,
    },
    logo: {
        width: 30,
        height: 30,
        marginBottom: 20,
        marginLeft: 10,
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

