import React from "react";
import {
    Dimensions,
    Platform,
    Text,
    View,
    ViewStyle,
    StyleSheet,
} from "react-native";
import { Pressable } from "react-native-web-hover";
import { usePathname, useRouter } from "expo-router";
import { useMediaQuery } from "react-responsive";
import { useTranslation } from "react-i18next";
import { SideBarItem } from "./SideBarItem";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/Logo";
import Avatar from "@/components/Avatar";
import { Home, HomeActive } from "@/assets/icons/home-icon";
import { Bookmark, BookmarkActive } from "@/assets/icons/bookmark-icon";
import { Gear, GearActive } from "@/assets/icons/gear-icon";
import { Search, SearchActive } from "@/assets/icons/search-icon";
import { ComposeIcon } from "@/assets/icons/compose-icon";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@oxyhq/services";
import { confirmDialog } from "@/utils/alerts";
import { List, ListActive } from "@/assets/icons/list-icon";
import { Video, VideoActive } from "@/assets/icons/video-icon";
import { Hashtag, HashtagActive } from "@/assets/icons/hashtag-icon";
import { AnalyticsIcon, AnalyticsIconActive } from "@/assets/icons/analytics-icon";
import { useTheme } from "@/hooks/useTheme";
import { Chat, ChatActive } from '@/assets/icons/chat-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';

const IconComponent = Ionicons as any;

const WindowHeight = Dimensions.get('window').height;

export function SideBar() {
    const { t } = useTranslation();
    const router = useRouter();
    const { isAuthenticated: _isAuthenticated, user, showBottomSheet, logout, oxyServices } = useAuth();
    const theme = useTheme();

    const avatarUri = user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') : undefined;

    const handleSignOut = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.signOut'),
            message: t('settings.signOutMessage'),
            okText: t('settings.signOut'),
            cancelText: t('common.cancel'),
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
                title: t("Home"),
                icon: <Home color={theme.colors.text} />,
                iconActive: <HomeActive color={theme.colors.primary} />,
                route: '/',
            },
            ...(user ? [{
                title: t("Profile"),
                icon: <Avatar source={avatarUri} size={24} />,
                iconActive: <Avatar source={avatarUri} size={24} />,
                route: `/@${user.username}`,
            }] : []),
            {
                title: t("Explore"),
                icon: <Search color={theme.colors.text} />,
                iconActive: <SearchActive color={theme.colors.primary} />,
                route: '/explore',
            },
            {
                title: t("Notifications"),
                icon: <Bell color={theme.colors.text} />,
                iconActive: <BellActive color={theme.colors.primary} />,
                route: '/notifications',
            },
            {
                title: t("Chat"),
                icon: <Chat color={theme.colors.text} />,
                iconActive: <ChatActive color={theme.colors.primary} />,
                route: '/chat',
            },
            {
                title: t("Insights"),
                icon: <AnalyticsIcon color={theme.colors.text} />,
                iconActive: <AnalyticsIconActive color={theme.colors.primary} />,
                route: '/insights',
            },
            {
                title: t("Saved"),
                icon: <Bookmark color={theme.colors.text} />,
                iconActive: <BookmarkActive color={theme.colors.primary} />,
                route: '/saved',
            },
            {
                title: t("Feeds"),
                icon: <Hashtag color={theme.colors.text} />,
                iconActive: <HashtagActive color={theme.colors.primary} />,
                route: '/feeds',
            },
            {
                title: t("Lists"),
                icon: <List color={theme.colors.text} />,
                iconActive: <ListActive color={theme.colors.primary} />,
                route: '/lists',
            },
            {
                title: t("Videos"),
                icon: <Video color={theme.colors.text} />,
                iconActive: <VideoActive color={theme.colors.primary} />,
                route: '/videos',
            },
            {
                title: t("Settings"),
                icon: <Gear color={theme.colors.text} />,
                iconActive: <GearActive color={theme.colors.primary} />,
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
                    { backgroundColor: theme.colors.background },
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
                            boxShadow: '0px 2px 3.84px 0px rgba(0, 0, 0, 0.25)',
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
                                            color: theme.colors.card,
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
                                    ]}>{t("New Post")}</Text>
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
                                        <ComposeIcon size={20} color={theme.colors.card} />
                                    </View>
                                )}
                                containerStyle={() => ({
                                    ...styles.addPropertyButton,
                                    backgroundColor: theme.colors.primary,
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
                                icon={<IconComponent name="log-out-outline" size={20} color={theme.colors.text} />}
                                text={t('settings.signOut')}
                                isExpanded={isExpanded}
                                onHoverExpand={handleHoverIn}
                                onPress={handleSignOut}
                            />
                        ) : (
                            <SideBarItem
                                isActive={false}
                                icon={<IconComponent name="log-in-outline" size={20} color={theme.colors.text} />}
                                text={t('Sign In')}
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
        fontSize: 20,
        fontWeight: 'bold',
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
        borderRadius: 25,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    signUpButtonText: {
        fontSize: 13,
        fontWeight: "bold",
    },
    signInButton: {
        justifyContent: "center",
        alignItems: "center",
        borderRadius: 25,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    signInButtonText: {
        fontSize: 13,
        fontWeight: "bold",
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
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
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
        fontSize: 16,
        fontWeight: 'bold',
        textAlign: 'center',
        margin: 0,
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
        marginBottom: 16,
    },
    menuItemText: {
        fontSize: 16,
        marginLeft: 12,
    },
    footerText: {
        fontSize: 14,
        textAlign: 'center',
    },
});

