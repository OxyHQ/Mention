import type { SharedValue } from 'react-native-reanimated';

/**
 * The pager's props, in a module BOTH forks can name.
 *
 * A shared `types.ts` beside a platform fork is the same shape Bloom uses
 * (`src/tab-bar/types.ts`), and for the same reason: export conditions do not
 * apply to relative specifiers, so a consumer's `tsc` and a web bundler must be
 * able to reach the types without resolving through the native file — which
 * imports `react-native-pager-view`, a package with no web implementation at
 * all.
 */
export interface TabsPagerProps {
  /** The tabs navigator's state, from `useTabsWithTriggers`. */
  state: {
    index: number;
    routes: { key: string; name: string }[];
  };
  /** Its descriptors, keyed by route key. Only `render()` is used. */
  descriptors: Record<string, { render: () => React.ReactNode }>;
  /**
   * The bottom bar's highlight position, in tab units. The pager writes it on
   * every frame of a swipe, on the UI thread; see `context/TabPagerContext.tsx`
   * for who else may (nobody, while this is mounted).
   */
  progress: SharedValue<number>;
  /** Report a page the reader actually landed on, so the route can follow. */
  onCommit: (index: number) => void;
}
