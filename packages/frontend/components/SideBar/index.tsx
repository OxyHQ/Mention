import React, { useCallback, useMemo } from "react";
import {
    Dimensions,
    Platform,
    Pressable,
    Text,
    View,
    ViewStyle,
    StyleSheet,
} from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useIsScreenNotMobile, useIsSideBarExpanded } from "@/hooks/useOptimizedMediaQuery";
import { useTranslation } from "react-i18next";
import { SideBarItem } from "./SideBarItem";
import { Avatar } from '@oxyhq/bloom/avatar';
import { MentionAvatarIcon } from '../MentionAvatarIcon';
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
import { useTheme } from '@oxyhq/bloom/theme';
import { logger } from '@/lib/logger';
import { Chat, ChatActive } from '@/assets/icons/chat-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { Agora, AgoraActive } from '@mention/agora-shared';

const WindowHeight = Dimensions.get('window').height;

const webCursorPointer = Platform.select({ web: { cursor: 'pointer' } }) as ViewStyle | undefined;

interface SideBarProps {
    asDrawer?: boolean;
    onNavigate?: () => void;
}

export function SideBar({ asDrawer = false, onNavigate }: SideBarProps) {
    const { t } = useTranslation();
    const router = useRouter();
    const { user, signIn, logout } = useAuth();
    const theme = useTheme();
    const avatarUri = user?.avatar;

    const handleSignOut = useCallback(async () => {
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
            onNavigate?.();
            router.replace('/');
        } catch (error) {
            logger.error('Logout failed');
        }
    }, [t, logout, onNavigate, router]);

    const handleNavPress = useCallback((route: string) => {
        onNavigate?.();
        router.push(route);
    }, [onNavigate, router]);

    const handleComposePress = useCallback(() => {
        if (asDrawer) {
            handleNavPress('/compose');
        } else {
            router.push('/compose');
        }
    }, [asDrawer, handleNavPress, router]);

    const handleSignIn = useCallback(() => {
        onNavigate?.();
        signIn().catch(() => {});
    }, [onNavigate, signIn]);

    const sideBarData = useMemo(() => [
        {
            title: t("sidebar.home"),
            icon: <Home />,
            iconActive: <HomeActive />,
            route: '/',
        },
        ...(user ? [{
            title: t("sidebar.profile"),
            icon: <Avatar source={avatarUri} size={24} placeholderIcon={<MentionAvatarIcon size={14} />} />,
            iconActive: <Avatar source={avatarUri} size={24} placeholderIcon={<MentionAvatarIcon size={14} />} />,
            route: `/@${user.username}`,
        }] : []),
        {
            title: t("sidebar.explore"),
            icon: <Search />,
            iconActive: <SearchActive />,
            route: '/explore',
        },
        {
            title: t("sidebar.notifications"),
            icon: <Bell />,
            iconActive: <BellActive />,
            route: '/notifications',
        },
        {
            title: t("sidebar.chat"),
            icon: <Chat />,
            iconActive: <ChatActive />,
            route: '/chat',
        },
        {
            title: t("sidebar.agora"),
            icon: <Agora />,
            iconActive: <AgoraActive />,
            route: '/agora',
        },
        {
            title: t("sidebar.insights"),
            icon: <AnalyticsIcon />,
            iconActive: <AnalyticsIconActive />,
            route: '/insights',
        },
        {
            title: t("sidebar.saved"),
            icon: <Bookmark />,
            iconActive: <BookmarkActive />,
            route: '/saved',
        },
        {
            title: t("sidebar.feeds"),
            icon: <Hashtag />,
            iconActive: <HashtagActive />,
            route: '/feeds',
        },
        {
            title: t("sidebar.lists"),
            icon: <List />,
            iconActive: <ListActive />,
            route: '/lists',
        },
        {
            title: t("sidebar.videos"),
            icon: <Video />,
            iconActive: <VideoActive />,
            route: '/videos',
        },
        {
            title: t("sidebar.settings"),
            icon: <Gear />,
            iconActive: <GearActive />,
            route: '/settings',
        },
    ], [t, user, avatarUri]);

    const pathname = usePathname();
    const isSideBarVisible = useIsScreenNotMobile();
    const isExpanded = useIsSideBarExpanded();

    const composeButtonBg = useMemo(() => ({ backgroundColor: theme.colors.primary }), [theme.colors.primary]);
    const composeTextColor = useMemo(() => ({ color: theme.colors.card }), [theme.colors.card]);

    if (!asDrawer && !isSideBarVisible) return null;

    const showExpanded = asDrawer || isExpanded;

    return (
        <View
            className="bg-background"
            style={[
                asDrawer ? styles.drawerContainer : styles.container,
                !asDrawer && { width: showExpanded ? 240 : 60 },
                !asDrawer && pathname === '/search' ? styles.searchShadow : undefined,
            ]}
        >
            <View style={styles.inner}>
                <View style={[
                    styles.navigationSection,
                    { alignItems: showExpanded ? 'flex-start' : 'center' },
                ]}>
                    {sideBarData.map(({ title, icon, iconActive, route }) => (
                        <SideBarItem
                            href={asDrawer ? undefined : route}
                            key={title}
                            icon={pathname === route ? iconActive : icon}
                            text={title}
                            isActive={pathname === route}
                            isExpanded={showExpanded}
                            onPress={asDrawer ? () => handleNavPress(route) : undefined}
                        />
                    ))}

                    <View style={styles.composeButtonContainer}>
                        <Pressable
                            onPress={handleComposePress}
                            style={[
                                styles.composeButton,
                                composeButtonBg,
                                showExpanded ? styles.composeButtonExpanded : styles.composeButtonCollapsed,
                                webCursorPointer,
                            ]}
                        >
                            {showExpanded ? (
                                <Text style={{ color: theme.colors.card, fontSize: 17, fontWeight: '800', textAlign: 'center' }}>
                                    {t("sidebar.compose")}
                                </Text>
                            ) : (
                                <ComposeIcon size={26} color={theme.colors.card} />
                            )}
                        </Pressable>
                    </View>
                </View>

                <View style={[
                    styles.footer,
                    { alignItems: showExpanded ? 'flex-start' : 'center' },
                ]}>
                    {user && user.id ? (
                        <SideBarItem
                            isActive={false}
                            icon={<Ionicons name="log-out-outline" size={20} color={theme.colors.text} />}
                            text={t('sidebar.signOut')}
                            isExpanded={showExpanded}
                            onPress={handleSignOut}
                        />
                    ) : (
                        <SideBarItem
                            isActive={false}
                            icon={<Ionicons name="log-in-outline" size={20} color={theme.colors.text} />}
                            text={t('sidebar.signIn')}
                            isExpanded={showExpanded}
                            onPress={handleSignIn}
                        />
                    )}
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        padding: 6,
        ...(Platform.select({
            web: {
                position: 'sticky' as any,
                overflow: 'hidden',
                height: '100vh' as any,
            },
            default: {
                height: WindowHeight,
            },
        }) as ViewStyle),
        top: 0,
        zIndex: 1000,
    },
    drawerContainer: {
        flex: 1,
        width: 280,
        padding: 12,
    },
    inner: {
        flex: 1,
        width: '100%',
        justifyContent: 'flex-start',
        alignItems: 'center',
    },
    navigationSection: {
        flex: 1,
        justifyContent: 'center',
        width: '100%',
        gap: 2,
    },
    composeButton: {
        borderRadius: 100,
        justifyContent: 'center',
        alignItems: 'center',
    },
    composeButtonExpanded: {
        width: '100%',
        paddingVertical: 12,
        paddingHorizontal: 12,
    },
    composeButtonCollapsed: {
        width: 50,
        height: 50,
    },
    composeButtonContainer: {
        minHeight: 60,
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    searchShadow: {
        boxShadow: '0px 2px 3.84px 0px rgba(0, 0, 0, 0.25)',
        elevation: 5,
    } as ViewStyle,
    footer: {
        flexDirection: 'column',
        justifyContent: 'flex-end',
        width: '100%',
        marginTop: 'auto',
    },
});
