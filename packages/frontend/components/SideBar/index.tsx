import React from "react";
import {
    Dimensions,
    Platform,
    Text,
    View,
    ViewStyle,
    StyleSheet,
} from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useMediaQuery } from "react-responsive";
import { useTranslation } from "react-i18next";
import { SideBarItem } from "./SideBarItem";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/Logo";
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

export function SideBar() {
    const { t } = useTranslation();
    const router = useRouter();
    const { isAuthenticated: _isAuthenticated, user, signIn, logout, oxyServices } = useAuth();
    const theme = useTheme();
    const avatarUri = user?.avatar;

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
            logger.error('Logout failed');
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
    const isSideBarVisible = useMediaQuery({ minWidth: 500 });
    const isExpanded = useMediaQuery({ minWidth: 1300 });

    if (!isSideBarVisible) return null;

    return (
        <View
            className="bg-background"
            style={[
                styles.container,
                { width: isExpanded ? 240 : 60 },
                pathname === '/search' ? {
                    boxShadow: '0px 2px 3.84px 0px rgba(0, 0, 0, 0.25)',
                    elevation: 5,
                } : {},
            ]}
        >
            <View style={styles.inner}>
                <View style={styles.headerSection}>
                    <Logo />
                </View>
                <View style={[
                    styles.navigationSection,
                    { alignItems: isExpanded ? 'flex-start' : 'center' },
                ]}>
                    {sideBarData.map(({ title, icon, iconActive, route }) => (
                        <SideBarItem
                            href={route}
                            key={title}
                            icon={pathname === route ? iconActive : icon}
                            text={title}
                            isActive={pathname === route}
                            isExpanded={isExpanded}
                        />
                    ))}

                    <View style={styles.composeButtonContainer}>
                        <Button
                            href="/compose"
                            renderText={isExpanded ? () => (
                                <Text
                                    className="text-primary-foreground text-base font-bold text-center m-0 whitespace-nowrap"
                                >{t("New Post")}</Text>
                            ) : undefined}
                            renderIcon={!isExpanded ? () => (
                                <ComposeIcon size={20} className="text-primary-foreground" />
                            ) : undefined}
                            containerStyle={() => ({
                                ...styles.composeButton,
                                backgroundColor: theme.colors.primary,
                                height: isExpanded ? 40 : 48,
                                width: isExpanded ? '100%' : 48,
                                alignSelf: isExpanded ? 'stretch' : 'center',
                            })}
                        />
                    </View>
                </View>

                <View style={[
                    styles.footer,
                    { alignItems: isExpanded ? 'flex-start' : 'center' },
                ]}>
                    {user && user.id ? (
                        <SideBarItem
                            isActive={false}
                            icon={<IconComponent name="log-out-outline" size={20} color={theme.colors.text} />}
                            text={t('settings.signOut')}
                            isExpanded={isExpanded}
                            onPress={handleSignOut}
                        />
                    ) : (
                        <SideBarItem
                            isActive={false}
                            icon={<IconComponent name="log-in-outline" size={20} color={theme.colors.text} />}
                            text={t('Sign In')}
                            isExpanded={isExpanded}
                            onPress={() => signIn().catch(() => {})}
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
    inner: {
        flex: 1,
        width: '100%',
        justifyContent: 'flex-start',
        alignItems: 'center',
    },
    headerSection: {
        marginBottom: 16,
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
