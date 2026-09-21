import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { BottomBar as BloomBottomBar } from '@oxy.so/bloom/bottom-bar';
import { Fab } from '@oxy.so/bloom/fab';
import { Avatar } from '@oxy.so/bloom/avatar';
import { RiHome5Line } from '@oxy.so/bloom/icons/RiHome5Line';
import { RiVideoLine } from '@oxy.so/bloom/icons/RiVideoLine';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { RiQuillPenLine } from '@oxy.so/bloom/icons/RiQuillPenLine';
import { useAuth } from '@oxy.so/services/ui/client';
import { useHaptics } from '@oxy.so/bloom/hooks';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { useHomeRefresh } from '@/context/HomeRefreshContext';
import { useTabPager } from '@/context/TabPagerContext';
import { useBottomBarHidden } from '@/context/BottomBarVisibilityContext';
import { BAR_TABS, CHROME_HIDDEN_BY_PAGE, barToPage, pageIndexByName, type BarTabName } from '@/components/navigation/tabs';
import { useUnreadCount } from '@/hooks/useUnreadCount';
import { UnreadBadge } from '@/components/notifications/UnreadBadge';

function NotificationGlyph({ count, label, ...iconProps }: React.ComponentProps<typeof RiNotification3Line> & { count: number; label: string }) {
  return <View><RiNotification3Line {...iconProps} /><UnreadBadge count={count} accessibilityLabel={label} /></View>;
}

/** Mention owns destinations and pager state; Bloom owns all navigation chrome. */
export const BottomBar = () => {
  const { showBottomSheet, user } = useAuth();
  const { t } = useTranslation();
  const haptic = useHaptics();
  const { triggerHomeRefresh } = useHomeRefresh();
  const unreadCount = useUnreadCount();
  const minimizeProgress = useBottomBarHidden();
  const { progress, chromeProgress, activeIndex, activePage, selectTab } = useTabPager();
  const glyphs = useMemo<Record<BarTabName, React.ReactNode>>(() => ({
    index: <RiHome5Line />,
    videos: <RiVideoLine />,
    notifications: <NotificationGlyph count={unreadCount} label={t('notification.badge', { count: unreadCount, defaultValue: '{{count}} unread notifications' })} />,
    you: <Avatar size={26} source={user?.avatar} variant={MEDIA_VARIANT_AVATAR} />,
  }), [unreadCount, t, user?.avatar]);
  const items = useMemo(() => BAR_TABS.map(tab => ({ name: tab.name, label: t(tab.bar.labelKey), icon: glyphs[tab.name] })), [glyphs, t]);
  const onValueChange = useCallback((value: string) => {
    haptic('light');
    if (value === 'index' && BAR_TABS[activeIndex]?.name === 'index') {
      triggerHomeRefresh();
      return;
    }
    const index = BAR_TABS.findIndex(tab => tab.name === value);
    if (index >= 0) selectTab(barToPage(index));
  }, [activeIndex, haptic, selectTab, triggerHomeRefresh]);
  const onValueLongPress = useCallback((value: string) => {
    if (value !== 'you') return;
    haptic('heavy');
    showBottomSheet?.('ManageAccount');
  }, [haptic, showBottomSheet]);
  const chromeStyle = useAnimatedStyle(() => ({
    opacity: 1 - chromeProgress.value,
    transform: [{ translateY: chromeProgress.value * 160 }],
  }), [chromeProgress]);
  const hidden = activePage >= 0 && CHROME_HIDDEN_BY_PAGE[activePage] === 1;
  return <Animated.View style={chromeStyle} pointerEvents={hidden ? 'none' : 'auto'}>
    <BloomBottomBar
      items={items}
      value={BAR_TABS[activeIndex]?.name ?? ''}
      activeProgress={progress}
      onValueChange={onValueChange}
      onValueLongPress={onValueLongPress}
      minimizeProgress={minimizeProgress}
      action={<Fab icon={<RiQuillPenLine />} accessibilityLabel={t('sidebar.compose')} onPress={() => selectTab(pageIndexByName('write'))} />}
    />
  </Animated.View>;
};
