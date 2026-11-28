import { usePathname } from 'expo-router';
import { useDeckAvailable } from '@/components/deck/useDeckAvailable';
import { isDefaultLeadingDeckPanel } from '@/components/deck/deckEntry';
import { deckRouteForSource, useDeckSettings } from '@/components/deck/deckSettings';

const VIDEO_ROUTE = /^\/(?:videos|video-upload|watch(?:\/[^/]+)?|@[^/]+\/videos)\/?$/;

export function useRouteThemeMode(): 'dark' | undefined {
  const pathname = usePathname();
  const deckAvailable = useDeckAvailable();
  const focusedDeckRoute = useDeckSettings((state) => {
    if (!deckAvailable || (!state.deckEnabled && pathname !== '/deck')) return;
    const { activePanel, order, panels } = state;
    const panel = activePanel && panels[activePanel];
    if (!panel || (activePanel === order[0] && isDefaultLeadingDeckPanel(state))) return;
    const { navigation } = panel;
    return navigation?.entries[navigation.index]?.name ?? deckRouteForSource(panel.source).name;
  });
  const route = focusedDeckRoute?.split(/[?#]/, 1)[0] ?? pathname;
  return VIDEO_ROUTE.test(route) ? 'dark' : undefined;
}
