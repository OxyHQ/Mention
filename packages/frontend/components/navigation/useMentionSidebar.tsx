import { useCallback, useMemo } from 'react';
import type { BloomIconComponent } from '@oxy.so/bloom';
import { usePathname, useRouter, type Href } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { useDeckAvailable } from '@/components/deck/useDeckAvailable';
import { useDeckSettings } from '@/components/deck/deckSettings';
import { Avatar } from '@oxy.so/bloom/avatar';
import type { SidebarProps } from '@oxy.so/bloom/sidebar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { ProfileButton } from '@oxy.so/services/ui/client';
import { useAuth } from '@oxy.so/services/ui/client';
import type { AccountDialogMenuItem } from '@oxy.so/services';
import { RiDashboardLine } from '@oxy.so/bloom/icons/RiDashboardLine';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiGroupFill } from '@oxy.so/bloom/icons/RiGroupFill';
import { useUnreadCount } from '@/hooks/useUnreadCount';
import { profileHrefForUser } from '@/components/Profile/profileRoute';
import { LogoIcon } from '@/assets/logo';
import { useTheme } from '@oxy.so/bloom/theme';
import { useMentionSettings } from '@/context/MentionSettingsContext';
import { useDrawer } from '@/context/DrawerContext';
import { useNavigateOrReselect } from '@/hooks/useNavigateOrReselect';
import { RiBookmarkFill } from '@oxy.so/bloom/icons/RiBookmarkFill';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { RiHashtag } from '@oxy.so/bloom/icons/RiHashtag';
import { RiHome5Fill } from '@oxy.so/bloom/icons/RiHome5Fill';
import { RiHome5Line } from '@oxy.so/bloom/icons/RiHome5Line';
import { RiListUnordered } from '@oxy.so/bloom/icons/RiListUnordered';
import { RiMegaphoneFill } from '@oxy.so/bloom/icons/RiMegaphoneFill';
import { RiMegaphoneLine } from '@oxy.so/bloom/icons/RiMegaphoneLine';
import { RiNotification3Fill } from '@oxy.so/bloom/icons/RiNotification3Fill';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { RiQuillPenLine } from '@oxy.so/bloom/icons/RiQuillPenLine';
import { RiSearchFill } from '@oxy.so/bloom/icons/RiSearchFill';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { RiSettings3Fill } from '@oxy.so/bloom/icons/RiSettings3Fill';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiVideoFill } from '@oxy.so/bloom/icons/RiVideoFill';
import { RiVideoLine } from '@oxy.so/bloom/icons/RiVideoLine';
import { useCommunitiesPreview } from '@/hooks/useCommunitiesPreview';

// Navigation belongs to Mention; measurement, scrolling, FAB and drawer chrome
// belong to Bloom. The same descriptor feeds its desktop rail and mobile drawer.
export function useMentionSidebar(): SidebarProps {
  const { t } = useTranslation();
  const deckAvailable = useDeckAvailable();
  const deckEnabled = useDeckSettings((state) => state.deckEnabled);
  const router = useRouter();
  const { user, signIn } = useAuth();
  const communitiesPreview = useCommunitiesPreview();
  const avatarUri = user?.avatar;
  // Photo-less accounts get their initial, as in the Oxy account menu.
  const avatarName = user?.name?.displayName || user?.username || undefined;
  const unreadCount = useUnreadCount();
  const { close } = useDrawer();
  const settings = useMentionSettings();
  const navigateOrReselect = useNavigateOrReselect();
  const { colors } = useTheme();
  // The row for the page already open is not a destination: it takes the
  // reader back to the top, then reloads.
  const handleNavPress = useCallback(
    (route: Href) => {
      close();
      navigateOrReselect(route);
    },
    [close, navigateOrReselect],
  );
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
  const handleOpenSettings = useCallback(() => {
    close();
    settings.open();
  }, [close, settings]);
  const accountMenuItems = useMemo<AccountDialogMenuItem[]>(
    () => [
      {
        key: 'mention-settings',
        label: t('sidebar.accountMenu.settings'),
        icon: 'cog-outline',
        onPress: handleOpenSettings,
      },
      {
        key: 'mention-plus',
        label: t('sidebar.accountMenu.plus'),
        icon: 'crown-outline',
        onPress: () => handleNavPress('/plus'),
      },
    ],
    [t, handleOpenSettings, handleNavPress],
  );
  const sideBarData = useMemo<
    {
      title: string;
      icon: BloomIconComponent;
      iconActive: BloomIconComponent;
      route?: Href;
      onPress?: () => void;
    }[]
  >(() => {
    // The row's glyph is the reader's own avatar, at the box the sidebar asks for.
    const ProfileAvatarIcon: BloomIconComponent = ({ width }) => (
      <Avatar
        source={avatarUri}
        name={avatarName}
        size={width ?? 24}
        variant={MEDIA_VARIANT_AVATAR}
      />
    );
    return [
      {
        title: t('sidebar.home'),
        icon: RiHome5Line,
        iconActive: RiHome5Fill,
        route: '/',
      },
      ...(user
        ? [
            {
              title: t('sidebar.profile'),
              icon: ProfileAvatarIcon,
              iconActive: ProfileAvatarIcon,
              onPress: handleNavigateProfile,
            },
          ]
        : []),
      {
        title: t('sidebar.explore'),
        icon: RiSearchLine,
        iconActive: RiSearchFill,
        route: '/explore',
      },
      {
        title: t('sidebar.notifications'),
        icon: RiNotification3Line,
        iconActive: RiNotification3Fill,
        route: '/notifications',
      },
      {
        title: t('sidebar.liveRooms'),
        icon: RiBroadcastLine,
        iconActive: RiBroadcastLine,
        route: '/live-rooms',
      },
      {
        // Channels sits here rather than Insights: a user reaches their own
        // insights from their profile, so the row was a second door to a
        // place already one tap away, while channels had no door at all.
        title: t('sidebar.channels'),
        icon: RiMegaphoneLine,
        iconActive: RiMegaphoneFill,
        route: '/channels',
      },
      ...(communitiesPreview
        ? [
            {
              title: t('sidebar.communities', { defaultValue: 'Communities' }),
              icon: RiGroupLine,
              iconActive: RiGroupFill,
              route: '/communities' as Href,
            },
          ]
        : []),
      {
        title: t('sidebar.saved'),
        icon: RiBookmarkLine,
        iconActive: RiBookmarkFill,
        route: '/saved',
      },
      {
        title: t('sidebar.feeds'),
        icon: RiHashtag,
        iconActive: RiHashtag,
        route: '/feeds',
      },
      {
        title: t('sidebar.lists'),
        icon: RiListUnordered,
        iconActive: RiListUnordered,
        route: '/lists',
      },
      {
        title: t('sidebar.videos'),
        icon: RiVideoLine,
        iconActive: RiVideoFill,
        route: '/videos',
      },
      {
        title: t('sidebar.settings'),
        icon: RiSettings3Line,
        iconActive: RiSettings3Fill,
        route: '/settings',
        onPress: handleOpenSettings,
      },
    ];
  }, [
    t,
    user,
    avatarUri,
    avatarName,
    handleNavigateProfile,
    handleOpenSettings,
    communitiesPreview,
  ]);

  const pathname = usePathname();
  return {
    surface: 'plain',
    size: 'md',
    contentAlignment: 'center',
    showSearch: false,
    showThemeToggle: false,
    logo: {
      icon: <LogoIcon size={28} color={colors.text} />,
      accessibilityLabel: 'Mention',
      onPress: () => handleNavPress('/'),
    },
    selected: pathname,
    modes: deckAvailable
      ? [
          {
            key: 'standard',
            label: t('deck.mode.standard', 'Standard'),
            icon: RiHome5Line,
          },
          { key: 'deck', label: 'Deck', icon: RiDashboardLine },
        ]
      : undefined,
    mode: deckEnabled ? 'deck' : 'standard',
    modesPresentation: 'toggle',
    modesLabel: t('deck.mode.label', 'Deck mode'),
    onModeChange: (mode) => useDeckSettings.getState().setDeckEnabled(mode === 'deck'),
    items: sideBarData.map(({ title, icon, iconActive, route, onPress }) => {
      return {
        key: typeof route === 'string' ? route : title,
        label: title,
        // Bloom supplies the foreground paired with the selected surface.
        icon,
        activeIcon: iconActive,
        href: typeof route === 'string' ? route : undefined,
        onPress:
          onPress ??
          (() => {
            if (route) handleNavPress(route);
          }),
        badge: route === '/notifications' && unreadCount > 0 ? unreadCount : undefined,
      };
    }),
    primaryAction: {
      label: t('sidebar.compose'),
      icon: RiQuillPenLine,
      onPress: handleComposePress,
    },
    footer: ({ collapsed }) => (
      <ProfileButton
        expanded={!collapsed}
        menuItems={accountMenuItems}
        onNavigateProfile={handleNavigateProfile}
        onAddAccount={handleAddAccount}
      />
    ),
  };
}
