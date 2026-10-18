import type { ReactNode } from 'react';
import { Redirect, usePathname } from 'expo-router';
import { useDeckHome } from './useDeckHome';

/** Mount only at the root shell; panel routes must never inherit this policy. */
export function DeckHomeEntry({ children }: { children: ReactNode }) {
  const deckHome = useDeckHome();
  const pathname = usePathname();
  // Expo's navigator must remain mounted while the root destination changes.
  return (
    <>
      {children}
      {pathname === '/' && deckHome ? <Redirect href="/deck" /> : null}
    </>
  );
}
