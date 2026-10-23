import type React from 'react';
import type { SharedValue } from 'react-native-reanimated';

/**
 * NATIVE: Bloom's app shell minimizes its bottom bar from the active Screen's
 * collapse (`scroll="page"`), so there is nothing for the app to drive.
 */
export function BottomBarVisibilityProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/** The bar's minimize progress when the app drives it; native leaves it to Bloom. */
export function useBottomBarHidden(): SharedValue<number> | undefined {
  return undefined;
}
