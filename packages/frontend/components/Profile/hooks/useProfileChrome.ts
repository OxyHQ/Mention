import { useMemo, useState } from 'react';
import { Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  usePanelStickyTopInset,
  usePanelStickyTabsTopInset,
} from '@/components/shell/PanelChrome';
import { useProfileScroll } from './useProfileScroll';
import { LAYOUT } from '../types';
import type { ProfileTab } from '../types';

/**
 * Top-right header action icon metrics. `IconButton variant="icon"` renders a
 * 32×32 touch target and the cluster uses NativeWind `gap-1` (4px); the overlay
 * reserves that span plus breathing room so a long display name truncates
 * instead of sliding under the icons.
 */
const HEADER_ACTION_ICON_SIZE = 32;
const HEADER_ACTION_ICON_GAP = 4;
const HEADER_OVERLAY_ICON_CLEARANCE = 12;

/** Vertical room the compact header layout leaves for the action cluster. */
const COMPACT_HEADER_CONTENT_OFFSET = 60;

export interface ProfileChromeOptions {
  profileId?: string;
  currentTab: ProfileTab;
  currentLaneId?: string;
  /** How many icons the top-right cluster renders; sizes the name overlay. */
  headerActionCount: number;
  /**
   * Whether this profile has a banner band above the content. A person's does
   * (a tinted placeholder stands in when no image is set); a channel's does not
   * — the account has no banner to set, so the layout has no band for one.
   */
  hasBannerBand: boolean;
}

export type ProfileChrome = ReturnType<typeof useProfileChrome>;

/**
 * The profile page's scroll-driven chrome: the shared `scrollY`, the three
 * interpolations that ride it, the panel insets and the measured summary height.
 *
 * One owner for both profile screens. The chrome is where the two are MOST
 * alike — same banner fade curve, same compact-name reveal, same sticky tiers,
 * same three-way scroll ownership downstream — and it is also the part most
 * expensive to have drift, since every value here is a magic number tuned
 * against the others. What the two screens differ on arrives as options
 * ({@link ProfileChromeOptions.hasBannerBand}, the action count), never as a
 * second copy of the curve.
 */
export function useProfileChrome({
  profileId,
  currentTab,
  currentLaneId,
  headerActionCount,
  hasBannerBand,
}: ProfileChromeOptions) {
  const insets = useSafeAreaInsets();

  // Web sticky-chrome top insets, from the shared PanelChrome source of truth.
  // They carry the panel's `PANEL_TOP_INSET` gutter while the rounded shell
  // frame is shown (>=500px) and collapse to 0 at full-bleed so the banner /
  // header band / tab bar pin flush to the viewport top.
  const panelStickyTopInset = usePanelStickyTopInset();
  const panelStickyTabsTopInset = usePanelStickyTabsTopInset();

  const { scrollY, onScroll, assignScrollRef, scrollToContent } = useProfileScroll({
    profileId,
    currentTab,
    currentLaneId,
  });

  // Measured height of the profile summary; drives the compact-name reveal.
  const [contentHeight, setContentHeight] = useState(0);

  const headerBackgroundOpacity = useMemo(
    () =>
      scrollY.interpolate({
        inputRange: [0, LAYOUT.HEADER_HEIGHT_EXPANDED],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
    [scrollY],
  );

  // Pull-to-zoom banner parallax: on overscroll (negative offset, i.e. pulling
  // the content down past the top) the banner scales 1 → 1.5. On web
  // `window.scrollY` never goes negative, so this stays clamped at 1 (no
  // rubber-band there) while native's bouncing ScrollView drives the zoom.
  const bannerScale = useMemo(
    () =>
      scrollY.interpolate({
        inputRange: [-150, 0],
        outputRange: [1.5, 1],
        extrapolateLeft: 'extend',
        extrapolateRight: 'clamp',
      }),
    [scrollY],
  );

  // Guard the pre-measurement window: until the summary's onLayout reports a
  // real height, `contentHeight` is 0, which would make the interpolation input
  // range [-20, 20] resolve to ~0.5 at scrollY=0 and paint the overlay on top of
  // the header icons and the profile content. Keep the threshold strictly
  // positive and force opacity 0 until measured.
  const headerNameOpacity = useMemo<Animated.AnimatedInterpolation<number> | number>(() => {
    if (contentHeight <= 0) return 0;
    // Reveal a touch later than the exact content height so the overlay only
    // appears once the real name has scrolled out of view.
    const revealStart = Math.max(contentHeight - 20, 1);
    return scrollY.interpolate({
      inputRange: [revealStart, contentHeight + 20],
      outputRange: [0, 1],
      extrapolate: 'clamp',
    });
  }, [scrollY, contentHeight]);

  const headerOverlayRight = useMemo(
    () =>
      LAYOUT.DEFAULT_PADDING -
      8 +
      headerActionCount * HEADER_ACTION_ICON_SIZE +
      (headerActionCount - 1) * HEADER_ACTION_ICON_GAP +
      HEADER_OVERLAY_ICON_CLEARANCE,
    [headerActionCount],
  );

  const themedStyles = useMemo(
    () => ({
      container: { paddingTop: insets.top },
      headerActions: { top: insets.top + 6 },
      headerNameOverlay: { top: insets.top + 6, right: headerOverlayRight },
      scrollView: { marginTop: hasBannerBand ? LAYOUT.HEADER_HEIGHT_NARROWED : 0 },
      contentContainer: {
        paddingTop: hasBannerBand
          ? LAYOUT.HEADER_HEIGHT_EXPANDED - insets.top
          : insets.top + COMPACT_HEADER_CONTENT_OFFSET,
      },
    }),
    [insets.top, hasBannerBand, headerOverlayRight],
  );

  return {
    scrollY,
    onScroll,
    assignScrollRef,
    scrollToContent,
    contentHeight,
    setContentHeight,
    headerBackgroundOpacity,
    bannerScale,
    headerNameOpacity,
    themedStyles,
    panelStickyTopInset,
    panelStickyTabsTopInset,
  };
}
