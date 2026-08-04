import React from 'react';
import { Animated, ImageBackground, Platform, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import UserName from '@/components/UserName';
import { PANEL_HEADER_HEIGHT } from '@/components/shell/PanelChrome';
import type { ProfileData } from '@/hooks/useProfileData';
import { LAYOUT } from './types';
import type { ProfileChrome } from './hooks/useProfileChrome';

const IS_WEB = Platform.OS === 'web';

// Banner image wrapped for the pull-to-zoom parallax (scale driven by the shared
// scrollY). Created once at module scope so it is a stable component type.
const AnimatedImageBackground = Animated.createAnimatedComponent(ImageBackground);

/** Full height of the banner band. */
const BANNER_HEIGHT = LAYOUT.HEADER_HEIGHT_EXPANDED + LAYOUT.HEADER_HEIGHT_NARROWED;

export interface ProfileChromeLayersProps {
  chrome: ProfileChrome;
  /**
   * The banner band, or `null` for a layout that has none. A channel passes
   * `null`: the account has no banner field to set, so there is nothing to
   * reach — not a band left empty.
   */
  banner: { uri?: string } | null;
  /** The top-right icon cluster's contents. */
  headerActions: React.ReactNode;
  /** Resolved account, for the compact name overlay. */
  profileData: ProfileData;
}

/**
 * The four overlapping layers pinned above a profile's content: the banner, the
 * opaque header band, the top-right action cluster and the compact-name overlay.
 *
 * ONE copy on purpose. Every layer here carries hand-tuned z-indices, negative
 * margins and pointer-event rules that only make sense relative to each other,
 * and there are now two compositions that need them: {@link ProfileShell}, which
 * renders the whole page as one screen (native, and a channel on both
 * platforms), and `ProfileChromeFrame.web.tsx`, where the person profile's
 * chrome belongs to the `[username]` LAYOUT and the tab content is a routed
 * screen beneath it. A second copy would be correct for exactly as long as
 * nobody touched either.
 *
 * Every layer occupies ZERO net flow height — each is either `absolute`
 * (native) or `web:sticky` with a negative margin that cancels its own box — so
 * a caller composes them by rendering this ABOVE its content and offsetting that
 * content itself (`chrome.themedStyles.scrollView` +
 * `chrome.themedStyles.contentContainer`). Rendering it anywhere else changes
 * nothing about the layout and everything about the stacking order.
 */
export function ProfileChromeLayers({
  chrome,
  banner,
  headerActions,
  profileData,
}: ProfileChromeLayersProps) {
  const { t } = useTranslation();

  return (
    <>
      {/* Banner. NATIVE: `absolute left-0 right-0 top:0` (height 170,
          zIndex 1) over the NON-scrolling root — the content scrolls OVER
          it, and the `bg-background` overlay fades it out over the first
          120px via `headerBackgroundOpacity`. WEB: there is no inner
          ScrollView (the DOCUMENT scrolls), so an `absolute` banner would
          scroll away. Instead it is `web:sticky` + `panelStickyTopInset`
          (pinned to the rounded panel's PANEL_TOP_INSET top-gutter inset —
          from the single shared constant, no literal `top-2` here — and
          sticky's containing block is the panel column, so it stays INSIDE
          the panel, never viewport-fixed). The negative bottom margin
          (`-170px`) cancels its flow height so the content's own
          `marginTop + paddingTop` offset is NOT double-counted — the banner
          occupies 0 net flow and the content still starts ~170px down and
          scrolls over it, then fades to the background, exactly as on
          native. Its `web:z-[1]` keeps it BELOW the content (`zIndex: 3`),
          preserving native's content-over-banner layering. */}
      {banner &&
        (banner.uri ? (
          <View
            className="left-0 right-0 overflow-hidden web:sticky web:z-[1] web:[margin-bottom:-170px]"
            style={[webStickyChrome.banner, chrome.panelStickyTopInset, { height: BANNER_HEIGHT }]}
          >
            <AnimatedImageBackground
              source={{ uri: banner.uri }}
              className="absolute left-0 right-0 top-0 overflow-hidden"
              style={{ height: BANNER_HEIGHT, transform: [{ scale: chrome.bannerScale }] }}
            />
            <Animated.View
              className="absolute left-0 right-0 top-0 overflow-hidden bg-background"
              style={{
                height: BANNER_HEIGHT,
                zIndex: 1,
                pointerEvents: 'none',
                opacity: chrome.headerBackgroundOpacity,
              }}
            />
          </View>
        ) : (
          <View
            className="left-0 right-0 overflow-hidden bg-primary/[0.125] web:sticky web:z-[1] web:[margin-bottom:-170px]"
            style={[webStickyChrome.banner, chrome.panelStickyTopInset, { height: BANNER_HEIGHT }]}
          >
            <Animated.View
              className="bg-background"
              style={[StyleSheet.absoluteFill, { opacity: chrome.headerBackgroundOpacity }]}
            />
          </View>
        ))}

      {/* Pinned header-band surface (WEB only). When the header chrome is
          pinned in contact with the tab bar, the action cluster +
          compact-name overlay are 0-flow-height anchors with NO background
          of their own — so the scrolling feed (z-3) would show THROUGH the
          header band while the opaque tabs (`bg-background`) sit right
          below, reading as an incoherent transparent-header / opaque-tabs
          split. This sticky surface fills the 48px header band with the SAME
          `bg-background` token the tab bar uses, so header + tabs read as
          ONE cohesive opaque bar. Its opacity is driven by the SAME
          `headerBackgroundOpacity` as the banner fade: 0 when expanded (the
          banner shows through — restored parallax preserved) → 1 once
          scrolled (opaque, matching the tabs). `web:z-[100]` paints it ABOVE
          the feed content (z-3) and the tabs (z-5) but BELOW the chrome
          icons/name overlay (z-101). It intentionally receives web pointer
          events to prevent clicks from reaching covered feed content while
          the band is opaque; the higher z-101 header controls remain
          interactive. The `-48px` bottom margin keeps it a 0-flow overlay.
          Empty on native, where the chrome is an absolute overlay over the
          non-scrolling root. */}
      {IS_WEB && (
        <View
          className="left-0 right-0 web:sticky web:z-[100] web:pointer-events-auto web:[margin-bottom:-48px]"
          style={[chrome.panelStickyTopInset, { height: PANEL_HEADER_HEIGHT }]}
        >
          <Animated.View
            className="bg-background"
            style={[StyleSheet.absoluteFill, { opacity: chrome.headerBackgroundOpacity }]}
          />
        </View>
      )}

      {/* Header actions cluster. NATIVE: `absolute`, `top: insets.top+6`,
          `right: DEFAULT_PADDING-8`, zIndex 10 — pinned at the top of the
          non-scrolling root. WEB: the cluster lives inside a full-width
          `web:sticky` + `panelStickyTopInset` wrapper pinned to the panel's
          top-gutter inset (same pattern as the PanelStickyHeader the home
          header uses). The wrapper has 0 flow height (its only child is
          `absolute`) and is `pointer-events-none` so it never blocks the
          feed; the cluster itself re-enables pointer events. */}
      <View
        className="left-0 right-0 web:sticky web:z-[101] web:pointer-events-none"
        style={[webStickyChrome.chromeAnchor, chrome.panelStickyTopInset]}
      >
        <View
          className="absolute flex-row items-center gap-1 web:pointer-events-auto"
          style={[
            { zIndex: 10, right: LAYOUT.DEFAULT_PADDING - 8 },
            chrome.themedStyles.headerActions,
          ]}
        >
          {headerActions}
        </View>
      </View>

      {/* Compact name overlay (avatar + name + posts-count), fading in via
          `headerNameOpacity` once the real name scrolls past.

          It is `aria-hidden` because it is a purely visual restatement of
          the avatar, name, verified badge and post count the summary below
          already renders — a screen reader would otherwise announce that
          identity twice on every profile, and the overlay holds nothing
          focusable to lose. One prop covers all three platforms: RN's View
          maps `aria-hidden` onto `accessibilityElementsHidden` (iOS) AND
          `importantForAccessibility: 'no-hide-descendants'` (Android), and
          react-native-web emits the DOM attribute. */}
      <View
        className="left-0 right-0 web:sticky web:z-[101] web:pointer-events-none"
        style={[webStickyChrome.chromeAnchor, chrome.panelStickyTopInset]}
      >
        <Animated.View
          className="absolute"
          aria-hidden
          style={[
            {
              zIndex: 10,
              left: LAYOUT.DEFAULT_PADDING,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
            },
            chrome.themedStyles.headerNameOverlay,
            { opacity: chrome.headerNameOpacity },
            { pointerEvents: 'none' },
          ]}
        >
          <Avatar source={profileData.design.avatar} size={32} variant={MEDIA_VARIANT_AVATAR} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <UserName
              name={profileData.design.displayName}
              verified={profileData.verified}
              style={{ name: { fontSize: 18, fontWeight: 'bold', marginBottom: -3 } }}
              unifiedColors={true}
            />
            <Text className="text-muted-foreground text-[13px]" numberOfLines={1}>
              {t('profile.postsCount', {
                count: profileData.postsCount,
                defaultValue: `${profileData.postsCount} posts`,
              })}
            </Text>
          </View>
        </Animated.View>
      </View>
    </>
  );
}

// WEB vs NATIVE positioning for the profile header chrome (banner, action
// cluster, compact-name overlay). NATIVE pins each piece `absolute` to the top
// of the NON-scrolling root (the content scrolls over them inside the inner
// Animated.ScrollView). WEB has no inner ScrollView — the DOCUMENT scrolls — so
// each piece pins via `web:sticky` + the shared `panelStickyTopInset` style (the
// rounded panel's PANEL_TOP_INSET top-gutter inset, from the single PanelChrome
// source of truth — no literal `top-2` here). `position: sticky` keeps the panel
// column as its containing block, so the chrome stays INSIDE the rounded center
// panel (never viewport-fixed), mirroring the home header's PanelStickyHeader.
// These bespoke overlapping layers keep their own `web:z-[…]`, negative margins
// and pointer-events, so they consume `panelStickyTopInset` rather than the full
// <PanelStickyHeader> wrapper (which would flatten their z-layout and break the
// banner/name fades). The web `position`/`z` live in NativeWind classes; this
// StyleSheet only supplies the native `absolute` anchor (web entries are empty
// so the classes win).
const webStickyChrome = StyleSheet.create({
  banner: {
    ...Platform.select({
      web: {},
      default: { position: 'absolute' as const, top: 0, zIndex: 1 },
    }),
  },
  chromeAnchor: {
    ...Platform.select({
      web: {},
      default: { position: 'absolute' as const, top: 0, zIndex: 10 },
    }),
  },
});
