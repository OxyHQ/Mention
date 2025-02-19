import React, { useContext } from 'react'
import { Dimensions, Platform, Text, View, ViewStyle } from 'react-native'
import { usePathname } from 'expo-router';
import { useMediaQuery } from 'react-responsive'
import { widthPercentageToDP as wp } from 'react-native-responsive-screen'
import { useTranslation } from "react-i18next";
import { SideBarItem } from './SideBarItem'
import { colors } from '@/styles/colors'
import { Button } from '@/components/Button'
import { Ionicons } from "@expo/vector-icons";
import { Pressable } from 'react-native-web-hover'
import { Logo } from '@/components/Logo'
import { Home, HomeActive } from '@/assets/icons/home-icon'
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { Hashtag, HashtagActive } from '@/assets/icons/hashtag-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { Gear, GearActive } from '@/assets/icons/gear-icon';
import { Plus } from '@/assets/icons/plus-icon';
import { Chat, ChatActive } from '@/assets/icons/chat-icon';
import { List, ListActive } from '@/assets/icons/list-icon';
import { Feeds, FeedsActive } from '@/assets/icons/feeds-icon';
import { SessionOwnerButton } from '@/modules/oxyhqservices';
const WindowHeight = Dimensions.get('window').height;

import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { Search, SearchActive } from '@/assets/icons/search-icon';
import { Video, VideoActive } from '@/assets/icons/video-icon';
import { Compose } from '@/assets/icons/compose-icon';
import { Analytics, AnalyticsActive } from './analytics-icon';

export function SideBar() {

    const { t } = useTranslation();
    const sessionContext = useContext(SessionContext);
    const state = sessionContext ? sessionContext.state : null;

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
            icon: <Analytics color={colors.COLOR_BLACK} />,
            iconActive: <AnalyticsActive />,
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
                    {state && !state.isAuthenticated && (
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
                            <View
                                style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    marginVertical: 20,
                                    gap: 10,
                                }}
                            >
                                <Button
                                    href="/signup"
                                    renderText={({ state }) =>
                                        state === 'desktop' ? (
                                            <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }}>{t("Sign Up")}</Text>
                                        ) : null
                                    }
                                    renderIcon={() => null}
                                    containerStyle={({ state }) => ({
                                        justifyContent: 'center',
                                        alignItems: 'center',
                                        backgroundColor: colors.COLOR_BLACK,
                                        borderRadius: 25,
                                        paddingHorizontal: 15,
                                        paddingVertical: 8,
                                    })}
                                />
                                <Button
                                    href="/login"
                                    renderText={({ state }) =>
                                        state === 'desktop' ? (
                                            <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }}>{t("Sign In")}</Text>
                                        ) : null
                                    }
                                    renderIcon={() => null}
                                    containerStyle={({ state }) => ({
                                        justifyContent: 'center',
                                        alignItems: 'center',
                                        backgroundColor: colors.primaryColor,
                                        borderRadius: 25,
                                        paddingHorizontal: 15,
                                        paddingVertical: 8,
                                    })}
                                />
                            </View>
                        </View>
                    )}
                    {state && state.isAuthenticated && (
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
                <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', width: '100%' }}>
                    <SessionOwnerButton collapsed={!isFullSideBar} />
                </View>
            </View>
        )
    } else {
        return null
    }
}
