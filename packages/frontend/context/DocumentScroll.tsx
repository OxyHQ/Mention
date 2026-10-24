import type React from 'react';
import type { ReselectScroller } from '@/context/ScreenReselectContext';

/**
 * NATIVE: there is no document to follow. Every list binds its own Bloom Screen
 * (`useScreenScroll`), which drives the chrome and answers a reselect itself.
 */
export function DocumentScrollProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function useDocumentScroller(): ReselectScroller | null {
  return null;
}
