import type React from 'react';
import { useMemo, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@oxy.so/bloom/avatar';
import { RiHome5Line } from '@oxy.so/bloom/icons/RiHome5Line';
import { RiVideoLine } from '@oxy.so/bloom/icons/RiVideoLine';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import type { TabPage } from '@oxy.so/bloom/tab-pager';
import { TabPagerProvider } from '@oxy.so/bloom/tab-pager/expo-router';
import { useAuth } from '@oxy.so/services/ui/client';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { useUnreadCount } from '@/hooks/useUnreadCount';
import { UnreadBadge } from '@/components/notifications/UnreadBadge';

function NotificationGlyph({
  count,
  label,
  ...iconProps
}: React.ComponentProps<typeof RiNotification3Line> & { count: number; label: string }) {
  return (
    <View>
      <RiNotification3Line {...iconProps} />
      <UnreadBadge count={count} accessibilityLabel={label} />
    </View>
  );
}

/**
 * Mention's root pages, in pager order. Bloom owns the pager, the tabs
 * navigator, the bar's highlight and its presence; this is only what the pages
 * are.
 *
 * The camera sits left of Home with no bar item: reached by swiping right off
 * the feed, as on Instagram, and never preloaded (a neighbour would hold the
 * sensor open behind the feed). The composer is the bar's action, not an item:
 * it is the last page, past Profile on the side of the FAB, and mounts only
 * when opened. On web the profile page is the viewer's own
 * `/@handle`; on native it is `/you`.
 */
function useMentionTabPages(): TabPage[] {
  const { t } = useTranslation();
  const { user } = useAuth();
  const unreadCount = useUnreadCount();
  const username = user?.username;
  const avatar = user?.avatar;
  const avatarName = user?.name?.displayName || username || undefined;
  return useMemo(
    () => [
      { name: 'camera', href: '/camera' },
      {
        name: 'index',
        href: '/',
        preload: true,
        bar: { label: t('bottomBar.home'), icon: <RiHome5Line /> },
      },
      {
        name: 'videos',
        href: '/videos',
        preload: true,
        bar: { label: t('bottomBar.videos'), icon: <RiVideoLine /> },
      },
      {
        name: 'notifications',
        href: '/notifications',
        preload: true,
        bar: {
          label: t('bottomBar.notifications'),
          icon: (
            <NotificationGlyph
              count={unreadCount}
              label={t('notification.badge', {
                count: unreadCount,
                defaultValue: '{{count}} unread notifications',
              })}
            />
          ),
        },
      },
      {
        name: 'you',
        href: Platform.OS === 'web' && username ? `/@${username}` : '/you',
        preload: true,
        bar: {
          label: t('bottomBar.profile'),
          // `name` gives a photo-less account its initial on a tinted disc, the
          // fallback the Oxy account menu draws.
          icon: (
            <Avatar size={26} source={avatar} name={avatarName} variant={MEDIA_VARIANT_AVATAR} />
          ),
        },
      },
      // Last, right of Profile: the composer is the bar's FAB, which sits at
      // that end of the bar.
      { name: 'write', href: '/write' },
    ],
    [t, unreadCount, username, avatar, avatarName],
  );
}

/** Bloom's tab pager over Mention's pages; mounted above the app shell. */
export function MentionTabPager({ children }: { children: ReactNode }) {
  return <TabPagerProvider pages={useMentionTabPages()}>{children}</TabPagerProvider>;
}
