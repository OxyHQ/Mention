import React from 'react';
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
import { isCurrentRoute } from '@/hooks/useNavigateOrReselect';

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

/** Every tab, once: its id, its label key and its route. */
const TABS = [
  { id: 'all', label: 'All', href: '/explore' },
  { id: 'media', label: 'Media', href: '/explore/media' },
  { id: 'trending', label: 'Trending', href: '/explore/trending' },
  { id: 'people', label: 'Who to follow', href: '/explore/who-to-follow' },
  { id: 'starter-packs', label: 'Starter Packs', href: '/explore/starter-packs' },
] as const satisfies readonly { id: string; label: string; href: Href }[];

function pushTab(id: string) {
  const tab = TABS.find(candidate => candidate.id === id);
  if (tab) router.push(tab.href);
}

export default function ExploreLayout() {
  const { t } = useTranslation();
  const theme = useTheme();
  const pathname = usePathname();
  const activeTab = TABS.find(tab => isCurrentRoute(tab.href, pathname))?.id ?? 'all';
  const handleTabPress = useTabSelect<string>(activeTab, pushTab);

  return <View className="flex-1 web:z-auto">
    <SEO title={t('seo.explore.title')} description={t('seo.explore.description')} />
    <StatusBar style={theme.isDark ? 'light' : 'dark'} />
    <PageHeader title={t('Explore')} presentation="floating" actions={
      <Button appearance="subtle" tone="neutral" iconOnly icon={<Search size={20} />}
        onPress={() => router.push('/search')} accessibilityLabel={t('Search')} />
    } />
    <Tabs value={activeTab} onValueChange={handleTabPress} variant="underline">{TABS.map(tab => <TabsTrigger key={tab.id} value={tab.id} label={t(tab.label)} />)}</Tabs>
    <Slot />
  </View>;
}
