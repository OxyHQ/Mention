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
import { useReselect } from '@/context/ScreenReselectContext';

/**
 * Explore is a routed top-tab cluster: each tab is its own URL under `/explore`
 * (deep-linkable, reload-safe, shareable). This layout owns the shared chrome —
 * the Explore title, the horizontal tab bar (real navigation, not local state),
 * the auto-hiding sticky header insets, and the search FAB — and renders the
 * active child route via `<Slot/>`. The active tab is DERIVED from the current
 * pathname (the single source of truth), so a direct hit on `/explore/trending`
 * lands with that tab selected.
 */

type ExploreTab = 'all' | 'media' | 'trending' | 'people' | 'starter-packs';

/** Tab id → its route. Drives navigation on tap and (in reverse) active detection. */
const TAB_ROUTES: Record<ExploreTab, Href> = {
  all: '/explore',
  media: '/explore/media',
  trending: '/explore/trending',
  people: '/explore/who-to-follow',
  'starter-packs': '/explore/starter-packs',
};

/** Resolve the active tab from the current pathname (route is the source of truth). */
function tabFromPathname(pathname: string | null): ExploreTab {
  if (pathname?.endsWith('/media')) return 'media';
  if (pathname?.endsWith('/trending')) return 'trending';
  if (pathname?.endsWith('/who-to-follow')) return 'people';
  if (pathname?.endsWith('/starter-packs')) return 'starter-packs';
  return 'all';
}

export default function ExploreLayout() {
  const { t } = useTranslation();
  const theme = useTheme();
  const pathname = usePathname();
  const activeTab = tabFromPathname(pathname);
  const reselect = useReselect();
  const handleTabPress = useCallback(
    (id: string) => {
      if (id === activeTab) {
        reselect();
        return;
      }
      const route = TAB_ROUTES[id as ExploreTab];
      if (route) router.push(route);
    },
    [activeTab, reselect],
  );

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
    <Tabs value={activeTab} onValueChange={handleTabPress} variant="underline">{(tabs).map((tab: { id: string; label: string; count?: number }) => <TabsTrigger key={tab.id} value={tab.id} label={tab.label} count={tab.count} />)}</Tabs>
    <Slot />
  </View>;
}
