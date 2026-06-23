import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@oxyhq/services';

import { BOTTOM_BAR_RESERVED_SPACE } from '@/components/BottomBar';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';

const IS_WEB = Platform.OS === 'web';

/** Base gap (px) between a floating action button and its anchor edge. */
const BASE_FAB_OFFSET = 16;

/**
 * Bottom `offset` (px) for the Bloom `<Fab>` inside the `(app)` group.
 *
 * On mobile-web the BottomBar is `position: fixed` to the viewport bottom (see
 * `BottomBar.tsx`), so in the document-scroll model the FAB's `position: sticky`
 * anchor pins it to the viewport bottom too — it would land directly ON TOP of
 * the bar. Lifting the FAB by the bar's reserved footprint (pill + gap +
 * breathing margin) plus the safe-area inset keeps the FAB floating cleanly
 * ABOVE the bar. Everywhere the bar does not render (desktop web, native, or
 * anonymous mobile-web) the FAB keeps the plain 16px edge gap.
 */
export function useFabOffset(): number {
  const insets = useSafeAreaInsets();
  const isScreenNotMobile = useIsScreenNotMobile();
  const { isAuthenticated } = useAuth();

  if (IS_WEB && !isScreenNotMobile && isAuthenticated) {
    return BASE_FAB_OFFSET + BOTTOM_BAR_RESERVED_SPACE + insets.bottom;
  }
  return BASE_FAB_OFFSET;
}
