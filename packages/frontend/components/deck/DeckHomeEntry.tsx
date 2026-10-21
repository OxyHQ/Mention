import { useEffect, type ReactNode } from 'react';
import { usePathname } from 'expo-router';
import { useDeckHome } from './useDeckHome';
import { useDeckSettings } from './deckSettings';

/** Mount only at the root shell; panel routes must never inherit this policy. */
export function DeckHomeEntry({ children }: { children: ReactNode }) {
  const deckHome = useDeckHome();
  const pathname = usePathname();
  useEffect(() => {
    if (pathname === '/' && deckHome) useDeckSettings.getState().setDeckEnabled(true);
  }, [pathname, deckHome]);
  return children;
}
