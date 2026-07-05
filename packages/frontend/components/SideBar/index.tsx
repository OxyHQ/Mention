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
import { usePathname, useRouter, type Href } from "expo-router";
import { useIsScreenNotMobile, useIsSideBarExpanded } from "@/hooks/useOptimizedMediaQuery";
import { useTranslation } from "react-i18next";
import { SideBarItem } from "./SideBarItem";
import { Avatar } from '@oxyhq/bloom/avatar';

import { Home, HomeActive } from "@/assets/icons/home-icon";
import { Bookmark, BookmarkActive } from "@/assets/icons/bookmark-icon";
import { Gear, GearActive } from "@/assets/icons/gear-icon";
import { Search, SearchActive } from "@/assets/icons/search-icon";
import { ComposeIcon } from "@/assets/icons/compose-icon";
import { Ionicons } from "@expo/vector-icons";
import { confirmDialog } from "@/utils/alerts";
import { List, ListActive } from "@/assets/icons/list-icon";
import { Video, VideoActive } from "@/assets/icons/video-icon";
import { Hashtag, HashtagActive } from "@/assets/icons/hashtag-icon";
import { AnalyticsIcon, AnalyticsIconActive } from "@/assets/icons/analytics-icon";
import { useTheme, useBloomTheme } from '@oxyhq/bloom/theme';
import { logger } from '@/lib/logger';
import { useAppearanceStore } from '@/store/appearanceStore';
import { Chat, ChatActive } from '@/assets/icons/chat-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { Agora, AgoraActive } from '@mention/agora-shared';
import { useAuth } from '@oxyhq/services';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { asViewStyle, type WebViewStyle } from '@/types/webStyles';
import { clearViewerSessionCache } from '@/utils/sessionCache';

const WindowHeight = Dimensions.get('window').height;

const webCursorPointer: ViewStyle | undefined = Platform.OS === 'web'
    ? asViewStyle({ cursor: 'pointer' })
    : undefined;

// Under document-scroll on web the shell row is a tall flex container. A flex
// child defaults to `align-items: stretch`, which would stretch this column to
// the row's full (scrollable) height — leaving the sticky box nowhere to move,
// so it scrolls away with the document. `alignSelf: 'flex-start'` constrains the
// box to its own `100vh` height, sitting at the top of the tall row, so
// `position: sticky; top: 0` pins it while only the center feed scrolls.
const webStickyContainerStyle: WebViewStyle = {
    position: 'sticky',
    alignSelf: 'flex-start',
    overflow: 'hidden',
    height: '100vh',
};

interface SideBarProps {
    asDrawer?: boolean;
    onNavigate?: () => void;
}

export function SideBar({ asDrawer = false, onNavigate }: SideBarProps) {
    const { t } = useTranslation();
    const router = useRouter();
    const { user, signIn, signOut, isAuthenticated, isAuthResolved, isPrivateApiPending } = useAuth();
    const theme = useTheme();
    const { resetTheme } = useBloomTheme();
    const resetAppearance = useAppearanceStore((state) => state.reset);
    const avatarUri = user?.avatar;

    const handleSignOut = useCallback(async () => {
        try {
            await signOut();
        } catch (error: unknown) {
            logger.warn('Sign out failed', { error });
        }
        clearViewerSessionCache();
        resetAppearance();
        resetTheme();
        onNavigate?.();
        router.replace('/');
    }, [signOut, onNavigate, router, resetAppearance, resetTheme]);

    // Every sidebar destination is a TAB ROOT (home, the current user's own
    // profile, explore, notifications, chat, agora, insights, saved, feeds,
    // lists, videos, settings). With the (app) center now a Stack, `navigate`
    // pops to an existing instance of the target instead of stacking a new copy,
    // so repeatedly clicking tabs never grows the stack or duplicates Home.
    const handleNavPress = useCallback((route: Href) => {
        onNavigate?.();
        router.navigate(route);
    }, [onNavigate, router]);

    // Compose is a modal-presented detail, NOT a tab root, so it must always
    // `push` (in both the drawer and persistent-sidebar branches) — never
    // `navigate`, which would pop to / reuse an existing instance.
    const handleComposePress = useCallback(() => {
        onNavigate?.();
        router.push('/compose');
    }, [onNavigate, router]);

    const handleSignIn = useCallback(() => {
        onNavigate?.();
        signIn().catch(() => {});
    }, [onNavigate, signIn]);

    const profileHandle = getNormalizedUserHandle(user);

    const sideBarData = useMemo<Array<{ title: string; icon: React.ReactNode; iconActive: React.ReactNode; route?: Href; onPress?: () => void }>>(() => [
        {
            title: t("sidebar.home"),
            icon: <Home />,
            iconActive: <HomeActive />,
            route: '/',
        },
        ...(user ? [{
            title: t("sidebar.profile"),
            icon: <Avatar source={avatarUri} size={24} />,
            iconActive: <Avatar source={avatarUri} size={24} />,
            onPress: () => {
                if (profileHandle) {
                    handleNavPress(`/@${profileHandle}`);
                }
            },
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
    ], [t, user, avatarUri, profileHandle, handleNavPress]);

    const pathname = usePathname();
    const isSideBarVisible = useIsScreenNotMobile();
    const isExpanded = useIsSideBarExpanded();
    const showAuthPlaceholder = !isAuthResolved || isPrivateApiPending || (isAuthenticated && !user);

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
                    {sideBarData.map(({ title, icon, iconActive, route, onPress }) => (
                        <SideBarItem
                            href={asDrawer ? undefined : route}
                            key={title}
                            icon={pathname === route ? iconActive : icon}
                            text={title}
                            isActive={pathname === route}
                            isExpanded={showExpanded}
                            onPress={onPress || (asDrawer && route ? () => handleNavPress(route) : undefined)}
                        />
                    ))}

                    <View style={styles.composeButtonContainer}>
                        <Pressable
                            onPress={handleComposePress}
                            className="bg-primary"
                            style={[
                                styles.composeButton,
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
                    {/* Auth-sensitive footer. Three states:
                        1. UNDETERMINED (`!isAuthResolved`): cold-boot session restore
                           has not concluded, so `user`/`isAuthenticated` are not yet a
                           reliable answer. Render a neutral skeleton of the same
                           footprint as a SideBarItem so the column does not shift and
                           we never flash the "Sign In" item before snapping to authed.
                        2. AUTHED (`user`): show Sign Out.
                        3. ANON (resolved, no user): show Sign In.
                        Gating on the SAME reactive condition as the profile row above
                        (truthy `user`) keeps the two in agreement. */}
                    {showAuthPlaceholder ? (
                        <View
                            className={showExpanded ? 'w-full self-stretch px-4' : 'self-center px-3'}
                            style={styles.footerSkeleton}
                        >
                            <View className="bg-muted rounded-full w-6 h-6" />
                            {showExpanded && (
                                <View className="bg-muted rounded-full h-3.5 flex-1 ml-3 mr-6" />
                            )}
                        </View>
                    ) : isAuthenticated ? (
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
        ...(Platform.OS === 'web'
            ? asViewStyle(webStickyContainerStyle)
            : { height: WindowHeight }),
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
    // Neutral placeholder for the auth-resolving window. Mirrors SideBarItem's
    // footprint (icon row: py-2.5 = 10px vertical + 24px icon, mb-1.5 = 6px)
    // so swapping to the real Sign-in/Sign-out item causes no layout shift.
    footerSkeleton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        marginBottom: 6,
    },
});
