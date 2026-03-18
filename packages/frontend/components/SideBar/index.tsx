import React, { useCallback } from "react";
import {
    Dimensions,
    Platform,
    Text,
    View,
    ViewStyle,
    StyleSheet,
} from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useIsScreenNotMobile, useIsSideBarExpanded } from "@/hooks/useOptimizedMediaQuery";
import { useTranslation } from "react-i18next";
import { SideBarItem } from "./SideBarItem";
import { Button } from "@/components/ui/Button";
import { Avatar } from '@oxyhq/bloom/avatar';
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

const IconComponent = Ionicons as any;

const WindowHeight = Dimensions.get('window').height;

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

    const sideBarData: {
        title: string;
        icon: React.ReactNode;
        iconActive: React.ReactNode;
        route: string;
    }[] = [
            {
                title: t("Home"),
                icon: <Home />,
                iconActive: <HomeActive />,
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
                icon: <Search />,
                iconActive: <SearchActive />,
                route: '/explore',
            },
            {
                title: t("Notifications"),
                icon: <Bell />,
                iconActive: <BellActive />,
                route: '/notifications',
            },
            {
                title: t("Chat"),
                icon: <Chat />,
                iconActive: <ChatActive />,
                route: '/chat',
            },
            {
                title: t("Agora"),
                icon: <Agora />,
                iconActive: <AgoraActive />,
                route: '/agora',
            },
            {
                title: t("Insights"),
                icon: <AnalyticsIcon />,
                iconActive: <AnalyticsIconActive />,
                route: '/insights',
            },
            {
                title: t("Saved"),
                icon: <Bookmark />,
                iconActive: <BookmarkActive />,
                route: '/saved',
            },
            {
                title: t("Feeds"),
                icon: <Hashtag />,
                iconActive: <HashtagActive />,
                route: '/feeds',
            },
            {
                title: t("Lists"),
                icon: <List />,
                iconActive: <ListActive />,
                route: '/lists',
            },
            {
                title: t("Videos"),
                icon: <Video />,
                iconActive: <VideoActive />,
                route: '/videos',
            },
            {
                title: t("Settings"),
                icon: <Gear />,
                iconActive: <GearActive />,
                route: '/settings',
            },
        ];

    const pathname = usePathname();
    const isSideBarVisible = useIsScreenNotMobile();
    const isExpanded = useIsSideBarExpanded();
    // In drawer mode, always render expanded regardless of media queries
    if (!asDrawer && !isSideBarVisible) return null;

    const showExpanded = asDrawer || isExpanded;

    return (
        <View
            className="bg-background"
            style={[
                asDrawer ? styles.drawerContainer : styles.container,
                !asDrawer && { width: showExpanded ? 240 : 60 },
                !asDrawer && pathname === '/search' ? {
                    boxShadow: '0px 2px 3.84px 0px rgba(0, 0, 0, 0.25)',
                    elevation: 5,
                } : {},
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
                        <Button
                            href={asDrawer ? undefined : "/compose"}
                            onPress={asDrawer ? () => handleNavPress('/compose') : undefined}
                            renderText={showExpanded ? () => (
                                <Text
                                    className="text-primary-foreground text-base font-bold text-center m-0 whitespace-nowrap"
                                >{t("New Post")}</Text>
                            ) : undefined}
                            renderIcon={!showExpanded ? () => (
                                <ComposeIcon size={20} className="text-primary-foreground" />
                            ) : undefined}
                            containerStyle={() => ({
                                ...styles.composeButton,
                                backgroundColor: theme.colors.primary,
                                height: showExpanded ? 40 : 48,
                                width: showExpanded ? '100%' : 48,
                                alignSelf: showExpanded ? 'stretch' : 'center',
                            })}
                        />
                    </View>
                </View>

                <View style={[
                    styles.footer,
                    { alignItems: showExpanded ? 'flex-start' : 'center' },
                ]}>
                    {user && user.id ? (
                        <SideBarItem
                            isActive={false}
                            icon={<IconComponent name="log-out-outline" size={20} color={theme.colors.text} />}
                            text={t('settings.signOut')}
                            isExpanded={showExpanded}
                            onPress={handleSignOut}
                        />
                    ) : (
                        <SideBarItem
                            isActive={false}
                            icon={<IconComponent name="log-in-outline" size={20} color={theme.colors.text} />}
                            text={t('Sign In')}
                            isExpanded={showExpanded}
                            onPress={() => {
                                onNavigate?.();
                                signIn().catch(() => {});
                            }}
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
                cursor: 'initial',
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
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 100,
    },
    composeButtonContainer: {
        minHeight: 60,
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    footer: {
        flexDirection: 'column',
        justifyContent: 'flex-end',
        width: '100%',
        marginTop: 'auto',
    },
});
