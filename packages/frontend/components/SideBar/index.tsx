import React from 'react';
import {
    Dimensions,
    Platform,
    Text,
    View,
    ViewStyle,
    StyleSheet,
} from 'react-native';
import { Pressable } from 'react-native-web-hover';
import { usePathname, useRouter } from 'expo-router';
import { useMediaQuery } from 'react-responsive';
import { useTranslation } from 'react-i18next';
import { SideBarItem } from './SideBarItem';
import { colors } from '@/styles/colors';
import { Button } from '@/components/SideBar/Button';
import { Logo } from '@/components/Logo';
import Avatar from '@/components/Avatar';
import { Home, HomeActive } from '@/assets/icons/home-icon';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { Gear, GearActive } from '@/assets/icons/gear-icon';
import { Search, SearchActive } from '@/assets/icons/search-icon';
import { ComposeIcon } from '@/assets/icons/compose-icon';
import { Ionicons } from '@expo/vector-icons';
import { useOxy } from '@oxyhq/services';
import { confirmDialog } from '@/utils/alerts';
import { List, ListActive } from '@/assets/icons/list-icon';
import { Video, VideoActive } from '@/assets/icons/video-icon';
import { Hashtag, HashtagActive } from '@/assets/icons/hashtag-icon';
import { AnalyticsIcon, AnalyticsIconActive } from '@/assets/icons/analytics-icon';
import { Chat, ChatActive } from '@/assets/icons/chat-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';

const IconComponent = Ionicons as any;

const WindowHeight = Dimensions.get('window').height;

export function SideBar() {
    const { t } = useTranslation();
    const router = useRouter();
    const { isAuthenticated: _isAuthenticated, user, showBottomSheet, logout, oxyServices } = useOxy();

    const avatarUri = user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') : undefined;

    const handleSignOut = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.signOut'),
            message: t('settings.signOutMessage'),
            okText: t('settings.signOut'),
            cancelText: t('cancel'),
            destructive: true,
        });
        if (!confirmed) return;
        try {
            await logout();
            router.replace('/');
        } catch (error) {
            console.error('Logout failed:', error);
        }
    };

    const sideBarData: {
        title: string;
        icon: React.ReactNode;
        iconActive: React.ReactNode;
        route: string;
    }[] = [
            {
                title: 'Home',
                icon: <Home color={colors.COLOR_BLACK} />,
                iconActive: <HomeActive />,
                route: '/',
            },
            ...(user ? [{
                title: 'Profile',
                icon: <Avatar source={avatarUri} size={24} />,
                iconActive: <Avatar source={avatarUri} size={24} />,
                route: `/@${user.username}`,
            }] : []),
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
                title: t("Saved"),
                icon: <Bookmark color={colors.COLOR_BLACK} />,
                iconActive: <BookmarkActive />,
                route: '/saved',
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
        ];

    const pathname = usePathname();
    const isSideBarVisible = useMediaQuery({ minWidth: 500 });
    const [isExpanded, setIsExpanded] = React.useState(false);
    const hoverCollapseTimeout = React.useRef<ReturnType<typeof setTimeout> | null>(
        null
    );

    const handleHoverIn = React.useCallback(() => {
        if (hoverCollapseTimeout.current) {
            clearTimeout(hoverCollapseTimeout.current);
            hoverCollapseTimeout.current = null;
        }
        setIsExpanded(true);
    }, []);

    const handleHoverOut = React.useCallback(() => {
        if (hoverCollapseTimeout.current) {
            clearTimeout(hoverCollapseTimeout.current);
        }
        hoverCollapseTimeout.current = setTimeout(() => setIsExpanded(false), 200);
    }, []);

    if (!isSideBarVisible) return null;

    if (isSideBarVisible) {
        return (
            <Pressable
                {...({ onHoverIn: handleHoverIn, onHoverOut: handleHoverOut } as any)}
                style={[
                    styles.container,
                    {
                        width: isExpanded ? 240 : 60,
                        padding: 6,
                        ...(Platform.select({
                            web: {
                                transition: 'width 220ms cubic-bezier(0.2, 0, 0, 1)',
                                willChange: 'width',
                            },
                        }) as ViewStyle),
                        ...(pathname === '/search' ? {
                            shadowColor: colors.primaryDark,
                            shadowOffset: { width: 0, height: 2 },
                            shadowOpacity: 0.25,
                            shadowRadius: 3.84,
                            elevation: 5,
                        } : {}),
                    },
                ]}
            >
                <View style={styles.inner}>
                    <View style={styles.headerSection}>
                        <Logo />
                    </View>
                    <View style={styles.navigationSection}>
                        {sideBarData.map(({ title, icon, iconActive, route }) => (
                            <SideBarItem
                                href={route}
                                key={title}
                                icon={pathname === route ? iconActive : icon}
                                text={title}
                                isActive={pathname === route}
                                isExpanded={isExpanded}
                                onHoverExpand={handleHoverIn}
                            />
                        ))}

                        <View style={styles.addPropertyButtonContainer}>
                            <Button
                                href="/compose"
                                renderText={() => (
                                    <Text style={[
                                        styles.addPostButtonText,
                                        {
                                            opacity: isExpanded ? 1 : 0,
                                            width: isExpanded ? 'auto' : 0,
                                            overflow: 'hidden',
                                            whiteSpace: 'nowrap',
                                            ...(Platform.select({
                                                web: {
                                                    transition: 'opacity 220ms cubic-bezier(0.2, 0, 0, 1), width 220ms cubic-bezier(0.2, 0, 0, 1)',
                                                    willChange: 'opacity, width',
                                                },
                                            }) as any),
                                        }
                                    ]}>Create Post</Text>
                                )}
                                renderIcon={() => (
                                    <View style={{
                                        opacity: isExpanded ? 0 : 1,
                                        position: isExpanded ? 'absolute' : 'relative',
                                        left: isExpanded ? '50%' : 'auto',
                                        top: isExpanded ? '50%' : 'auto',
                                        transform: isExpanded ? 'translate(-50%, -50%)' : 'none',
                                        ...(Platform.select({
                                            web: {
                                                transition: 'opacity 220ms cubic-bezier(0.2, 0, 0, 1)',
                                                willChange: 'opacity',
                                            },
                                        }) as any),
                                    }}>
                                        <ComposeIcon size={20} color={colors.primaryLight} />
                                    </View>
                                )}
                                containerStyle={() => ({
                                    ...styles.addPropertyButton,
                                    height: isExpanded ? 40 : 48,
                                    width: isExpanded ? '100%' : 48,
                                    alignSelf: isExpanded ? 'stretch' : 'center',
                                    ...(Platform.select({
                                        web: {
                                            transition: 'width 220ms cubic-bezier(0.2, 0, 0, 1), height 220ms cubic-bezier(0.2, 0, 0, 1)',
                                            willChange: 'width, height',
                                        },
                                    }) as ViewStyle),
                                })}
                            />
                        </View>
                    </View>

                    <View style={styles.footer}>
                        {user && user.id ? (
                            <SideBarItem
                                isActive={false}
                                icon={<IconComponent name="log-out-outline" size={20} color={colors.COLOR_BLACK} />}
                                text={t('settings.signOut')}
                                isExpanded={isExpanded}
                                onHoverExpand={handleHoverIn}
                                onPress={handleSignOut}
                            />
                        ) : (
                            <SideBarItem
                                isActive={false}
                                icon={<IconComponent name="log-in-outline" size={20} color={colors.COLOR_BLACK} />}
                                text={t('sidebar.actions.signIn')}
                                isExpanded={isExpanded}
                                onHoverExpand={handleHoverIn}
                                onPress={() => showBottomSheet?.('SignIn')}
                            />
                        )}
                    </View>
                </View>
            </Pressable>
        );
    }

    return null;
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: colors.primaryLight,
        padding: 12,
        ...(Platform.select({
            web: {
                position: 'sticky' as any,
                overflow: 'hidden',
                height: '100vh' as any,
                cursor: 'initial',
            },
            default: {
                height: WindowHeight,
            },
        }) as ViewStyle),
        top: 0,
        zIndex: 1000,
    },
    inner: {
        flex: 1,
        width: '100%',
        justifyContent: 'flex-start',
        alignItems: 'flex-start',
    },
    headerSection: {
        marginBottom: 16,
    },
    content: {
        justifyContent: 'flex-start',
        alignItems: 'flex-start',
        width: '100%',
    },
    heroSection: {
        marginTop: 8,
    },
    heroTagline: {
        color: colors.COLOR_BLACK,
        fontSize: 20,
        fontWeight: 'bold',
        fontFamily: 'Phudu',
        flexWrap: 'wrap',
        textAlign: 'left',
        maxWidth: 200,
        lineHeight: 24,
    },
    authButtonsContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginVertical: 12,
        gap: 8,
    },
    signUpButton: {
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.COLOR_BLACK,
        borderRadius: 25,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    signUpButtonText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: 'bold',
        fontFamily: 'Phudu',
    },
    signInButton: {
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.primaryColor,
        borderRadius: 25,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    signInButtonText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: 'bold',
        fontFamily: 'Phudu',
    },
    navigationSection: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'flex-start',
        width: '100%',
        gap: 2,
        paddingLeft: 0,
        paddingRight: 0,
    },
    addPropertyButton: {
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.primaryColor,
        borderRadius: 100,
        display: 'flex',
        alignSelf: 'flex-start',
        marginTop: 4,
    },
    addPropertyButtonContainer: {
        minHeight: 60,
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    addPostButtonText: {
        color: 'white',
        fontSize: 16,
        fontWeight: 'bold',
        textAlign: 'center',
        margin: 0,
        fontFamily: 'Phudu',
    },
    footer: {
        flexDirection: 'column',
        justifyContent: 'flex-end',
        alignItems: 'flex-start',
        width: '100%',
        marginTop: 'auto',
    },
    title: {
        fontSize: 24,
        color: colors.primaryDark,
        marginBottom: 16,
    },
    menuItemText: {
        fontSize: 16,
        color: colors.primaryDark,
        marginLeft: 12,
    },
    footerText: {
        fontSize: 14,
        color: colors.primaryDark_2,
        textAlign: 'center',
    },
});

