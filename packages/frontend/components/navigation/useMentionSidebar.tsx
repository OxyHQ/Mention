import React, { cloneElement, isValidElement, useCallback, useMemo } from 'react';
import { usePathname, useRouter, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@oxy.so/bloom/avatar';
import type { SidebarProps } from '@oxy.so/bloom/sidebar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { ProfileButton } from '@oxy.so/services';
import { useAuth } from '@oxy.so/services/ui/client';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { useUnreadCount } from '@/hooks/useUnreadCount';
import { profileHrefForUser } from '@/components/Profile/profileRoute';
import { LogoIcon } from '@/assets/logo';
import { useMentionSettings } from '@/context/MentionSettingsContext';
import { useDrawer } from '@/context/DrawerContext';
import { useNavigateOrReselect } from '@/hooks/useNavigateOrReselect';
import { Home, HomeActive } from '@/assets/icons/home-icon';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { Gear, GearActive } from '@/assets/icons/gear-icon';
import { Search, SearchActive } from '@/assets/icons/search-icon';
import { ComposeIcon } from '@/assets/icons/compose-icon';
import { List, ListActive } from '@/assets/icons/list-icon';
import { Video, VideoActive } from '@/assets/icons/video-icon';
import { Hashtag, HashtagActive } from '@/assets/icons/hashtag-icon';
import { ChannelIcon, ChannelIconActive } from '@/assets/icons/channel-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';

function LiveRoomsIcon({ size = 24, color }: { size?: number; color?: string }) {
    return <RiBroadcastLine width={size} height={size} fill={color} />;
}

function paintNavigationIcon(icon: React.ReactNode, width?: number, fill?: string) {
    if (!isValidElement<{ size?: number; color?: string }>(icon)) return icon;
    return cloneElement(icon, { size: width, ...(icon.type === Avatar ? {} : { color: fill }) });
}

// Navigation belongs to Mention; measurement, scrolling, FAB and drawer chrome
// belong to Bloom. The same descriptor feeds its desktop rail and mobile drawer.
export function useMentionSidebar(): SidebarProps {
    const { t } = useTranslation();
    const router = useRouter();
    const { user, signIn } = useAuth();
    const avatarUri = user?.avatar;
    // Photo-less accounts get their initial, as in the Oxy account menu.
    const avatarName = user?.name?.displayName || user?.username || undefined;
    const unreadCount = useUnreadCount();
    const { close } = useDrawer();
    const settings = useMentionSettings();
    const navigateOrReselect = useNavigateOrReselect();
    // The row for the page already open is not a destination: it takes the
    // reader back to the top, then reloads.
    const handleNavPress = useCallback((route: Href) => {
        close();
        navigateOrReselect(route);
    }, [close, navigateOrReselect]);
    const handleComposePress = useCallback(() => {
        close();
        router.push('/compose');
    }, [close, router]);
    const handleAddAccount = useCallback(() => {
        close();
        signIn().catch(() => {});
    }, [close, signIn]);
    const handleNavigateProfile = useCallback(() => {
        const href = profileHrefForUser(user);
        if (href) handleNavPress(href);
    }, [user, handleNavPress]);
    const handleNavigateManage = useCallback(() => { close(); settings.open(); }, [close, settings]);
    const sideBarData = useMemo<{ title: string; icon: React.ReactNode; iconActive: React.ReactNode; route?: Href; onPress?: () => void }[]>(() => [
        {
            title: t("sidebar.home"),
            icon: <Home />,
            iconActive: <HomeActive />,
            route: '/',
        },
        ...(user ? [{
            title: t("sidebar.profile"),
            icon: <Avatar source={avatarUri} name={avatarName} size={24} variant={MEDIA_VARIANT_AVATAR} />,
            iconActive: <Avatar source={avatarUri} name={avatarName} size={24} variant={MEDIA_VARIANT_AVATAR} />,
            onPress: handleNavigateProfile,
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
            title: t("sidebar.liveRooms"),
            icon: <LiveRoomsIcon />,
            iconActive: <LiveRoomsIcon />,
            route: '/live-rooms',
        },
        {
            // Channels sits here rather than Insights: a user reaches their own
            // insights from their profile, so the row was a second door to a
            // place already one tap away, while channels had no door at all.
            title: t("sidebar.channels"),
            icon: <ChannelIcon />,
            iconActive: <ChannelIconActive />,
            route: '/channels',
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
            onPress: handleNavigateManage,
        },
    ], [t, user, avatarUri, avatarName, handleNavigateProfile, handleNavigateManage]);

    const pathname = usePathname();
    return {
        surface: 'plain', size: 'md', contentAlignment: 'center', showSearch: false, showThemeToggle: false,
        logo: { icon: <LogoIcon size={28} className="text-foreground" />, accessibilityLabel: 'Mention', onPress: () => handleNavPress('/') },
        selected: pathname,
        items: sideBarData.map(({ title, icon, iconActive, route, onPress }) => ({
            key: typeof route === 'string' ? route : title,
            label: title,
            // Bloom supplies the foreground paired with the selected surface.
            icon: ({ width, fill }) => paintNavigationIcon(icon, width, fill),
            activeIcon: ({ width, fill }) => paintNavigationIcon(iconActive, width, fill),
            href: typeof route === 'string' ? route : undefined,
            onPress: onPress ?? (() => { if (route) handleNavPress(route); }),
            badge: route === '/notifications' && unreadCount > 0 ? unreadCount : undefined,
        })),
        primaryAction: { label: t('sidebar.compose'), icon: ({ width, fill }) => <ComposeIcon size={width ?? 26} color={fill} />, onPress: handleComposePress },
        footer: ({ collapsed }) => <ProfileButton expanded={!collapsed} onNavigateManage={handleNavigateManage} onNavigateProfile={handleNavigateProfile} onAddAccount={handleAddAccount} />,
    };
}
