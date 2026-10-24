import { useCallback, useMemo, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BloomIconComponent } from '@oxy.so/bloom';
import { Avatar } from '@oxy.so/bloom/avatar';
import { useHaptics } from '@oxy.so/bloom/hooks';
import { RiBookmarkFill } from '@oxy.so/bloom/icons/RiBookmarkFill';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiGroupFill } from '@oxy.so/bloom/icons/RiGroupFill';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiHashtag } from '@oxy.so/bloom/icons/RiHashtag';
import { RiHome5Fill } from '@oxy.so/bloom/icons/RiHome5Fill';
import { RiHome5Line } from '@oxy.so/bloom/icons/RiHome5Line';
import { RiListUnordered } from '@oxy.so/bloom/icons/RiListUnordered';
import { RiMegaphoneFill } from '@oxy.so/bloom/icons/RiMegaphoneFill';
import { RiMegaphoneLine } from '@oxy.so/bloom/icons/RiMegaphoneLine';
import { RiNotification3Fill } from '@oxy.so/bloom/icons/RiNotification3Fill';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { RiSearchFill } from '@oxy.so/bloom/icons/RiSearchFill';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { RiSettings3Fill } from '@oxy.so/bloom/icons/RiSettings3Fill';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiVideoFill } from '@oxy.so/bloom/icons/RiVideoFill';
import { RiVideoLine } from '@oxy.so/bloom/icons/RiVideoLine';
import type { AppDestination } from '@oxy.so/bloom/tab-pager';
import { TabPagerProvider } from '@oxy.so/bloom/tab-pager/expo-router';
import { useAuth } from '@oxy.so/services/ui/client';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { useMentionSettings } from '@/context/MentionSettingsContext';
import { useReselect } from '@/context/ScreenReselectContext';
import { useCommunitiesPreview } from '@/hooks/useCommunitiesPreview';
import { useUnreadCount } from '@/hooks/useUnreadCount';

/**
 * Every place Mention's navigation leads, declared once. Bloom draws the rest
 * from it: the pager's pages, the bottom bar, and the app shell's sidebar with
 * its selection, badges and drawer.
 *
 * The pages, in pager order: the camera left of Home with no item anywhere —
 * reached by swiping right off the feed, as on Instagram, and never preloaded
 * (a neighbour would hold the sensor open behind the feed) — and the composer
 * last, past Profile on the side of the bar's FAB, mounted only when opened.
 * On web the profile is the viewer's own `/@handle`; on native it is `/you`.
 */
export function useMentionDestinations(): AppDestination[] {
  const { t } = useTranslation();
  const { user, showBottomSheet } = useAuth();
  const haptic = useHaptics();
  const settings = useMentionSettings();
  const unreadCount = useUnreadCount();
  const communitiesPreview = useCommunitiesPreview();
  const username = user?.username;
  const avatar = user?.avatar;
  // Photo-less accounts get their initial, as in the Oxy account menu.
  const avatarName = user?.name?.displayName || username || undefined;
  // The reader's own avatar, at whatever box the bar or the sidebar asks for.
  const ProfileAvatar = useMemo<BloomIconComponent>(
    () =>
      ({ width }) => (
        <Avatar
          size={width ?? 26}
          source={avatar}
          name={avatarName}
          variant={MEDIA_VARIANT_AVATAR}
        />
      ),
    [avatar, avatarName],
  );
  const openAccounts = useCallback(() => {
    haptic('heavy');
    showBottomSheet?.('ManageAccount');
  }, [haptic, showBottomSheet]);

  return useMemo<AppDestination[]>(
    () => [
      { name: 'camera', href: '/camera', page: true },
      {
        name: 'index',
        href: '/',
        bar: true,
        preload: true,
        label: t('sidebar.home'),
        icon: RiHome5Line,
        activeIcon: RiHome5Fill,
      },
      {
        name: 'explore',
        href: '/explore',
        label: t('sidebar.explore'),
        icon: RiSearchLine,
        activeIcon: RiSearchFill,
      },
      {
        name: 'videos',
        href: '/videos',
        bar: true,
        preload: true,
        label: t('sidebar.videos'),
        icon: RiVideoLine,
        activeIcon: RiVideoFill,
      },
      {
        name: 'notifications',
        href: '/notifications',
        bar: true,
        preload: true,
        label: t('sidebar.notifications'),
        icon: RiNotification3Line,
        activeIcon: RiNotification3Fill,
        badge: unreadCount,
      },
      {
        name: 'live-rooms',
        href: '/live-rooms',
        label: t('sidebar.liveRooms'),
        icon: RiBroadcastLine,
      },
      {
        name: 'channels',
        href: '/channels',
        label: t('sidebar.channels'),
        icon: RiMegaphoneLine,
        activeIcon: RiMegaphoneFill,
      },
      ...(communitiesPreview
        ? [
            {
              name: 'communities',
              href: '/communities',
              label: t('sidebar.communities', { defaultValue: 'Communities' }),
              icon: RiGroupLine,
              activeIcon: RiGroupFill,
            },
          ]
        : []),
      {
        name: 'saved',
        href: '/saved',
        label: t('sidebar.saved'),
        icon: RiBookmarkLine,
        activeIcon: RiBookmarkFill,
      },
      { name: 'feeds', href: '/feeds', label: t('sidebar.feeds'), icon: RiHashtag },
      { name: 'lists', href: '/lists', label: t('sidebar.lists'), icon: RiListUnordered },
      {
        name: 'you',
        href: Platform.OS === 'web' && username ? `/@${username}` : '/you',
        bar: true,
        preload: true,
        // A signed-out reader has no profile to go to.
        sidebar: Boolean(user),
        label: t('sidebar.profile'),
        icon: ProfileAvatar,
        onLongPress: openAccounts,
      },
      {
        // A sheet, not a page.
        name: 'settings',
        href: '/settings',
        label: t('sidebar.settings'),
        icon: RiSettings3Line,
        activeIcon: RiSettings3Fill,
        onPress: settings.open,
      },
      { name: 'write', href: '/write', page: true },
    ],
    [
      t,
      unreadCount,
      communitiesPreview,
      username,
      user,
      ProfileAvatar,
      openAccounts,
      settings.open,
    ],
  );
}

/**
 * Bloom's navigation over Mention's destinations; mounted above the app shell.
 * Pressing the place already in front takes the reader back to the top of it,
 * then reloads.
 */
export function MentionNavigation({ children }: { children: ReactNode }) {
  return (
    <TabPagerProvider destinations={useMentionDestinations()} onReselect={useReselect()}>
      {children}
    </TabPagerProvider>
  );
}
