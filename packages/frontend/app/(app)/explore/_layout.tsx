import React, { useMemo } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { router, Slot } from 'expo-router';
import { RouterTabs, type RouterTabItem } from '@oxy.so/bloom/tabs/expo-router';
import { useTheme } from '@oxy.so/bloom/theme';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Search } from '@/assets/icons/search-icon';
import { SEO } from '@/components/SEO';
import { useReselect } from '@/context/ScreenReselectContext';

/**
 * Explore is a routed top-tab cluster: each tab is its own URL under `/explore`
 * (deep-linkable, reload-safe, shareable). This layout owns the shared chrome —
 * the Explore title, the horizontal tab bar (real navigation, not local state),
 * the auto-hiding sticky header insets, and the search FAB — and renders the
 * active child route via `<Slot/>`. `RouterTabs` derives the active tab from
 * the pathname, so a direct hit on `/explore/trending` lands with that tab
 * selected, and pressing the active tab reselects it instead of pushing it again.
 */
export default function ExploreLayout() {
  const { t } = useTranslation();
  const theme = useTheme();
  const reselect = useReselect();

  const tabs = useMemo<RouterTabItem[]>(
    () => [
      { value: 'all', label: t('All'), href: '/explore' },
      { value: 'media', label: t('Media'), href: '/explore/media' },
      { value: 'trending', label: t('Trending'), href: '/explore/trending' },
      { value: 'people', label: t('Who to follow'), href: '/explore/who-to-follow' },
      { value: 'starter-packs', label: t('Starter Packs'), href: '/explore/starter-packs' },
    ],
    [t],
  );

  return <View className="flex-1 web:z-auto">
    <SEO title={t('seo.explore.title')} description={t('seo.explore.description')} />
    <StatusBar style={theme.isDark ? 'light' : 'dark'} />
    <PageHeader title={t('Explore')} presentation="floating" actions={
      <Button appearance="subtle" tone="neutral" iconOnly icon={<Search size={20} />}
        onPress={() => router.push('/search')} accessibilityLabel={t('Search')} />
    } />
    <RouterTabs items={tabs} onReselect={reselect} variant="underline" swipeEnabled={false} />
    <Slot />
  </View>;
}
