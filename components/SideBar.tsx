import React from 'react'
import { Dimensions, Platform, Text, View, ViewStyle } from 'react-native'
import { usePathname } from 'expo-router';
import { useMediaQuery } from 'react-responsive'
import { widthPercentageToDP as wp } from 'react-native-responsive-screen'
import { SideBarItem } from './SideBarItem'
import { colors } from '@/styles/colors'
import { Button } from './Button'
import { Ionicons } from "@expo/vector-icons";
import { Pressable } from 'react-native-web-hover'
import { Logo } from './Logo'
import { Home, HomeActive } from '@/assets/icons/home-icon'
const WindowHeight = Dimensions.get('window').height

const sideBarData: { title: string; iconName: React.ComponentProps<typeof Ionicons>['name'], route: string }[] = [
    {
        title: 'Home',
        iconName: 'home',
        route: '/',
    },
    {
        title: 'Explore',
        iconName: 'search',
        route: '/explore',
    },
    {
        title: 'Notifications',
        iconName: 'notifications',
        route: '/notifications',
    },
    {
        title: 'Messages',
        iconName: 'chatbubbles',
        route: '/messages',
    },
    {
        title: 'Bookmarks',
        iconName: 'bookmark',
        route: '/bookmarks',
    },
    {
        title: 'Lists',
        iconName: 'list',
        route: '/lists',
    },
    {
        title: 'More',
        iconName: 'ellipsis-horizontal',
        route: '/more',
    },
]

export function SideBar() {
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
                        borderColor: colors.COLOR_BLACK_LIGHT_6,
                        borderRightWidth: 0.1,
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
                    {sideBarData.map(({ title, iconName, route }) => {
                        return <SideBarItem href={route} key={title}
                            icon={pathname === route ? <HomeActive /> : <Home color={colors.COLOR_BLACK} />}
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
