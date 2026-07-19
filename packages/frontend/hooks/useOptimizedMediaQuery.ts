import { useWindowDimensions } from 'react-native';

/**
 * Width-based responsive breakpoints for the cases that genuinely need a JS
 * boolean rather than a NativeWind class:
 *
 *  - MOUNT/UNMOUNT gates, so an off-breakpoint subtree never mounts and never
 *    runs its effects/fetches (e.g. the right rail's recommendation fetch).
 *  - DATA-level decisions — how many items a feed recommendation band renders
 *    and which layout (carousel vs list) it builds; a class cannot slice an
 *    array or swap a horizontal `ScrollView` for a vertical list.
 *  - Numeric layout math that no utility class expresses.
 *
 * Pure show/hide and pure styling differences use NativeWind responsive classes
 * (`md:`, `max-md:`, …) directly — NOT these hooks.
 *
 * Backed by React Native's `useWindowDimensions` (reactive on resize/rotate,
 * cross-platform, React-Compiler-safe) — no `react-responsive` / `matchMedia`
 * dependency.
 */

/** >= 500px: the sidebar/shell "not a phone" breakpoint. */
export function useIsScreenNotMobile(): boolean {
  return useWindowDimensions().width >= 500;
}

/** >= 990px: wide enough to show the right rail (widgets / video replies). */
export function useIsRightBarVisible(): boolean {
  return useWindowDimensions().width >= 990;
}

/** >= 1300px: wide enough to expand the sidebar from icons to labelled rows. */
export function useIsSideBarExpanded(): boolean {
  return useWindowDimensions().width >= 1300;
}
