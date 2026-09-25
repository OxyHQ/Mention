import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { router, Slot, usePathname, type Href } from 'expo-router';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useTheme } from '@oxy.so/bloom/theme';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Search } from '@/assets/icons/search-icon';
import { SEO } from '@/components/SEO';
import { useTabSelect } from '@/context/ScreenReselectContext';

/**
 * Explore is a routed top-tab cluster: each tab is its own URL under `/explore`
 * (deep-linkable, reload-safe, shareable). This layout owns the shared chrome —
 * the Explore title, the horizontal tab bar (real navigation, not local state),
 * the auto-hiding sticky header insets, and the search FAB — and renders the
 * active child route via `<Slot/>`. The active tab is DERIVED from the current
 * pathname, so a direct hit on `/explore/trending` lands with that tab selected.
 *
 * Not Bloom's `RouterTabs`: it prefetches every other tab's route on mount and
 * on each switch, which here would build the screens nobody opened.
 */

type ExploreTab = 'all' | 'media' | 'trending' | 'people' | 'starter-packs';

/** Tab id → its route: navigation on tap, and (in reverse) the active tab. */
const TAB_ROUTES: Record<ExploreTab, Href> = {
  all: '/explore',
  media: '/explore/media',
  trending: '/explore/trending',
  people: '/explore/who-to-follow',
  'starter-packs': '/explore/starter-packs',
};

function tabFromPathname(pathname: string): ExploreTab {
  const match = (Object.keys(TAB_ROUTES) as ExploreTab[]).find(tab => TAB_ROUTES[tab] === pathname);
  return match ?? 'all';
}

export default function ExploreLayout() {
  const { t } = useTranslation();
  const theme = useTheme();
  const activeTab = tabFromPathname(usePathname());
  const pushTab = useCallback((tab: string) => router.push(TAB_ROUTES[tab as ExploreTab]), []);
  const handleTabPress = useTabSelect<string>(activeTab, pushTab);

  const tabs = useMemo(
    () => [
      { id: 'all', label: t('All') },
      { id: 'media', label: t('Media') },
      { id: 'trending', label: t('Trending') },
      { id: 'people', label: t('Who to follow') },
      { id: 'starter-packs', label: t('Starter Packs') },
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
    <Tabs value={activeTab} onValueChange={handleTabPress} variant="underline">{tabs.map(tab => <TabsTrigger key={tab.id} value={tab.id} label={tab.label} />)}</Tabs>
    <Slot />
  </View>;
}
