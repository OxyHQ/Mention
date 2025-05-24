import { AnalyticsIcon, AnalyticsIconActive } from '@/assets/icons/analytics-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { Chat, ChatActive } from '@/assets/icons/chat-icon';
import { Compose } from '@/assets/icons/compose-icon';
import { Gear, GearActive } from '@/assets/icons/gear-icon';
import { Hashtag, HashtagActive } from '@/assets/icons/hashtag-icon';
import { Home, HomeActive } from '@/assets/icons/home-icon';
import { List, ListActive } from '@/assets/icons/list-icon';
import { Search, SearchActive } from '@/assets/icons/search-icon';
import { Video, VideoActive } from '@/assets/icons/video-icon';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/SideBar/Button';
import { colors } from '@/styles/colors';
import { useOxy } from '@oxyhq/services';
import { router, usePathname } from 'expo-router';
import React from 'react';
import { useTranslation } from "react-i18next";
import { Dimensions, Platform, StyleSheet, Text, TouchableOpacity, View, ViewStyle } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useMediaQuery } from 'react-responsive';
import { SideBarItem } from './SideBarItem';

const WindowHeight = Dimensions.get('window').height;

export function SideBar() {

    const { t } = useTranslation();
    const { logout, isLoading, user, isAuthenticated, showBottomSheet } = useOxy();

    
    const handleLogout = async () => {
        try {
            await logout();
            router.push('/');
        } catch (error) {
            console.error('Logout failed:', error);
        }
    };


    const sideBarData: { title: string; icon: React.ReactNode, iconActive: React.ReactNode, route: string }[] = [
        {
            title: 'Home',
            icon: <Home color={colors.COLOR_BLACK} />,
            iconActive: <HomeActive />,
            route: '/',
        },
        {
            title: t("Explore"),
            icon: <Search color={colors.COLOR_BLACK} />,
            iconActive: <SearchActive />,
            route: '/explore',
        },
        {
            title: t("Notifications"),
            icon: <Bell color={colors.COLOR_BLACK} />,
            iconActive: <BellActive />,
            route: '/notifications',
        },
        {
            title: 'Chat',
            icon: <Chat color={colors.COLOR_BLACK} />,
            iconActive: <ChatActive />,
            route: '/chat',
        },
        {
            title: t("Analytics"),
            icon: <AnalyticsIcon color={colors.COLOR_BLACK} />,
            iconActive: <AnalyticsIconActive />,
            route: '/analytics',
        },
        {
            title: t("Bookmarks"),
            icon: <Bookmark color={colors.COLOR_BLACK} />,
            iconActive: <BookmarkActive />,
            route: '/bookmarks',
        },
        {
            title: t("Feeds"),
            icon: <Hashtag color={colors.COLOR_BLACK} />,
            iconActive: <HashtagActive />,
            route: '/feeds',
        },
        {
            title: t("Lists"),
            icon: <List color={colors.COLOR_BLACK} />,
            iconActive: <ListActive />,
            route: '/lists',
        },
        {
            title: t("Videos"),
            icon: <Video color={colors.COLOR_BLACK} />,
            iconActive: <VideoActive />,
            route: '/videos',
        },
        {
            title: t("Settings"),
            icon: <Gear color={colors.COLOR_BLACK} />,
            iconActive: <GearActive />,
            route: '/settings',
        },
    ]

    const pathname = usePathname()
    const isSideBarVisible = useMediaQuery({ minWidth: 500 })
    const isFullSideBar = useMediaQuery({ minWidth: 1266 })
    const isRightBarVisible = useMediaQuery({ minWidth: 990 })

    if (!isSideBarVisible) return null

    if (isSideBarVisible) {
        return (
            <View
                style={
                    {
                        paddingVertical: 20,
                        height: WindowHeight,
                        // width: '30%',
                        paddingHorizontal: isFullSideBar ? 20 : 0,
                        alignItems: isFullSideBar ? 'flex-end' : 'center',
                        paddingEnd: !isFullSideBar ? 10 : 0,
                        width: isFullSideBar ? 360 : 60,
                        ...Platform.select({
                            web: {
                                position: 'sticky',
                            },
                        }),
                        top: 0,
                    } as ViewStyle
                }>
                <View
                    style={{
                        justifyContent: 'center',
                        alignItems: 'flex-start',
                    }}>
                    <Logo />
                    {!isAuthenticated && (
                        <View>
                            <Text
                                style={{
                                    color: colors.COLOR_BLACK,
                                    fontSize: 25,
                                    fontWeight: 'bold',
                                    flexWrap: 'wrap',
                                    textAlign: 'left',
                                    maxWidth: 200,
                                    lineHeight: 30,
                                }}
                            >{t("Join the conversation")}</Text>
                            {!isAuthenticated && (
                                <View
                                    style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        marginVertical: 20,
                                        gap: 10,
                                    }}
                                >
                                    <TouchableOpacity
                                        style={{
                                            justifyContent: 'center',
                                            alignItems: 'center',
                                            backgroundColor: colors.COLOR_BLACK,
                                            borderRadius: 25,
                                            paddingHorizontal: 15,
                                            paddingVertical: 8,
                                        }}
                                        onPress={() => showBottomSheet?.('SignUp')}
                                    >
                                        <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }}>{t("Sign Up")}</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        style={{
                                            justifyContent: 'center',
                                            alignItems: 'center',
                                            backgroundColor: colors.primaryColor,
                                            borderRadius: 25,
                                            paddingHorizontal: 15,
                                            paddingVertical: 8,
                                        }}
                                        onPress={() => showBottomSheet?.('SignIn')}
                                    >
                                        <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }}>{t("Sign In")}</Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                        </View>
                    )}
                    {isAuthenticated && (
                        <View style={{
                            justifyContent: 'center',
                            alignItems: 'flex-start',
                        }}>
                            {
                                sideBarData.map(({ title, icon, iconActive, route }) => {
                                    return <SideBarItem href={route} key={title}
                                        icon={pathname === route ? iconActive : icon}
                                        text={title}
                                        isActive={pathname === route} />
                                })}
                            <Button
                                renderText={({ state }) =>
                                    state === 'desktop' ? (
                                        <Text className="text-white text-[17px] font-bold">
                                            New Post
                                        </Text>
                                    ) : null
                                }
                                renderIcon={({ state }) =>
                                    state === 'tablet' ? (
                                        <Compose size={24} color={colors.primaryLight} />
                                    ) : null
                                }
                                containerStyle={({ state }) => ({
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    backgroundColor: colors.primaryColor,
                                    borderRadius: 100,
                                    height: state === 'desktop' ? 47 : 50,
                                    width: state === 'desktop' ? 220 : 50,
                                    ...(state === 'desktop'
                                        ? {}
                                        : {
                                            alignSelf: 'center',
                                        }),
                                })}
                            />
                        </View>)}
                </View>
                <View style={{ flex: 1, }}></View>
                <View style={{ width: '100%', paddingHorizontal: 20, }}>
                    {isAuthenticated && (
                                        <View style={styles.logoutContainer}>
                                            <TouchableOpacity
                                                style={styles.logoutButton}
                                                onPress={handleLogout}
                                            >
                                                <Ionicons name="log-out-outline" size={20} color="#fff" />
                                                <Text style={styles.logoutButtonText}>Logout</Text>
                                            </TouchableOpacity>
                                        </View>
                                    )}
                </View>
            </View>
        )
    } else {
        return null
    }
}

const styles = StyleSheet.create({
    // Logout
    logoutContainer: {
        padding: 16,
        marginBottom: 20,
    },
    logoutButton: {
        backgroundColor: '#E0245E',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
        borderRadius: 50,
    },
    logoutButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
        marginLeft: 8,
    },
});