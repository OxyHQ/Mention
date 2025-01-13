import React from 'react'
import { Dimensions, Platform, Text, View, ViewStyle } from 'react-native'
import { usePathname } from 'expo-router';
import { useMediaQuery } from 'react-responsive'
import { widthPercentageToDP as wp } from 'react-native-responsive-screen'
import { useTranslation } from "react-i18next";
import { SideBarItem } from './SideBarItem'
import { colors } from '@/styles/colors'
import { Button } from './Button'
import { Ionicons } from "@expo/vector-icons";
import { Pressable } from 'react-native-web-hover'
import { Logo } from './Logo'
import { Home, HomeActive } from '@/assets/icons/home-icon'
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { Hashtag, HashtagActive } from '@/assets/icons/hashtag-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { Gear, GearActive } from '@/assets/icons/gear-icon';
import { Plus } from '@/assets/icons/plus-icon';
import { Chat } from '@/assets/icons/chat-icon';
const WindowHeight = Dimensions.get('window').height



export function SideBar() {

    const { t } = useTranslation();

    const sideBarData: { title: string; icon: React.ReactNode, iconActive: React.ReactNode, route: string }[] = [
        {
            title: 'Home',
            icon: <Home color={colors.COLOR_BLACK} />,
            iconActive: <HomeActive />,
            route: '/',
        },
        {
            title: t("Explore"),
            icon: <Hashtag color={colors.COLOR_BLACK} />,
            iconActive: <HashtagActive />,
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
            iconActive: <Chat />,
            route: '/chat',
        },
        {
            title: t("Bookmarks"),
            icon: <Bookmark color={colors.COLOR_BLACK} />,
            iconActive: <BookmarkActive />,
            route: '/bookmarks',
        },
        {
            title: t("Lists"),
            icon: <Home color={colors.COLOR_BLACK} />,
            iconActive: <HomeActive />,
            route: '/lists',
        },
        {
            title: t("More"),
            icon: <Plus color={colors.COLOR_BLACK} />,
            iconActive: <Plus />,
            route: '/more',
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
                        // paddingHorizontal: 5,
                        flex: isFullSideBar ? 1.4 : isRightBarVisible ? 0.45 : 0.35,
                        // alignItems: isFullSideBar ? 'flex-end' : 'center',
                        alignItems: 'flex-end',
                        paddingEnd: !isFullSideBar ? 10 : 0,
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
                    <Pressable
                        style={({ hovered }) => [
                            {
                                borderRadius: 100,
                                marginStart: 4,
                                marginTop: 5,
                                ...Platform.select({
                                    web: {
                                        cursor: 'pointer',
                                    },
                                }),
                            },
                            hovered
                                ? {
                                    backgroundColor: `${colors.primaryColor}33`,
                                }
                                : {},
                        ]}>
                        <Logo />
                    </Pressable>
                    {sideBarData.map(({ title, icon, iconActive, route }) => {
                        return <SideBarItem href={route} key={title}
                            icon={pathname === route ? iconActive : icon}
                            text={title}
                            isActive={pathname === route} />
                    })}
                    <Button
                        renderText={({ state }) =>
                            state === 'desktop' ? (
                                <Text style={{ color: '#fff', fontSize: 17, fontWeight: 'bold' }}>
                                    New Post
                                </Text>
                            ) : null
                        }
                        renderIcon={({ state }) =>
                            state === 'tablet' ? (
                                <Ionicons name="create-outline" size={24} color={colors.primaryLight} />
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
                </View>
            </View>
        )
    } else {
        return null
    }
}
