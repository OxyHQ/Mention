import React from 'react';
import { Animated, ImageBackground, Platform, StatusBar, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import UserName from '@/components/UserName';
import { BottomBarAwareFab } from '@/components/BottomBarAwareFab';
import { EmptyState } from '@/components/common/EmptyState';
import { NoUpdatesIllustration } from '@/assets/illustrations/NoUpdates';
import { ComposeIcon } from '@/assets/icons/compose-icon';
import { PANEL_HEADER_HEIGHT } from '@/components/shell/PanelChrome';
import { useSafeBack } from '@/hooks/useSafeBack';
import type { ProfileData } from '@/hooks/useProfileData';
import { ProfileSkeleton } from './ProfileSkeleton';
import { ProfileTabs } from './ProfileTabs';
import { LAYOUT, shouldFeedOwnProfileScroll, shouldGridOwnProfileScroll } from './types';
import type { ProfileTabsProps } from './types';
import type { ProfileChrome } from './hooks/useProfileChrome';

const IS_WEB = Platform.OS === 'web';

// Banner image wrapped for the pull-to-zoom parallax (scale driven by the shared
// scrollY). Created once at module scope so it is a stable component type.
const AnimatedImageBackground = Animated.createAnimatedComponent(ImageBackground);

/** Full height of the banner band. */
const BANNER_HEIGHT = LAYOUT.HEADER_HEIGHT_EXPANDED + LAYOUT.HEADER_HEIGHT_NARROWED;

export interface ProfileShellProps {
  chrome: ProfileChrome;
  loading: boolean;
  profileData: ProfileData | null;
  /**
   * The banner band, or `null` for a layout that has none. A channel passes
   * `null`: the account has no banner field to set, so there is nothing to
   * reach — not a band left empty.
   */
  banner: { uri?: string } | null;
  /** The top-right icon cluster's contents. */
  headerActions: React.ReactNode;
  /**
   * Identity block, stats and everything above the tab strip.
   *
   * A single ELEMENT rather than a `ReactNode`, because on native the
   * virtualized-list branch hands it straight to FlashList as
   * `ListHeaderComponent`, which takes an element and not a fragment or a text
   * node.
   */
  summary: React.ReactElement | null;
  /** The tab strip itself, sticky in the second tier. Same element constraint. */
  tabBar: React.ReactElement | null;
  /** Which surface the active tab renders. */
  tabs: ProfileTabsProps;
  /**
   * Which anatomy the loading skeleton should hold space for. Defaults to a
   * person; a channel's page is a different shape, not a smaller one.
   */
  skeletonVariant?: 'person' | 'channel';
}

/**
 * The chrome and scroll model every profile page shares, whoever the account is.
 *
 * This is the half of a profile screen that is genuinely common: the banner
 * fade, the pinned header band, the two sticky tiers, the compact-name overlay,
 * the three-way scroll ownership (web document / native virtualized list /
 * native ScrollView), the skeleton and not-found states, and the compose FAB.
 * None of it depends on whether the account is a person or a channel — the
 * differences arrive as slots and as {@link ProfileShellProps.banner}.
 *
 * It exists so that splitting the two screens does not duplicate this. Every
 * layer below carries hand-tuned z-indices, negative margins and pointer-event
 * rules that only make sense relative to each other; a second copy would be
 * correct for exactly as long as nobody touched either.
 */
export function ProfileShell({
  chrome,
  loading,
  profileData,
  banner,
  headerActions,
  summary,
  tabBar,
  tabs,
  skeletonVariant = 'person',
}: ProfileShellProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const safeBack = useSafeBack();

  const nativeFeedOwnsScroll = shouldFeedOwnProfileScroll({
    tab: tabs.tab,
    isWeb: IS_WEB,
    isPrivate: tabs.isPrivate,
    isOwnProfile: tabs.isOwnProfile,
  });
  const nativeGridOwnsScroll = shouldGridOwnProfileScroll({
    tab: tabs.tab,
    isWeb: IS_WEB,
    isPrivate: tabs.isPrivate,
    isOwnProfile: tabs.isOwnProfile,
  });
  const nativeListOwnsScroll = nativeFeedOwnsScroll || nativeGridOwnsScroll;

  return (
    /* WEB: `web:z-auto` stops this screen wrapper from being its own stacking
       context (RN-web otherwise renders every View as `position:relative;
       z-index:0`, which would TRAP the sticky header chrome below it). With
       `z-index:auto` the profile chrome (banner z-1, action cluster + compact
       name z-101) competes directly in the rounded panel's stacking context, so
       it paints ABOVE the bleed-mask overlay (z-30) and the feed (z-3) but below
       the panel border frame (z-120) — exactly like the home header. No effect
       on native. */
    <View
      className="flex-1 bg-background web:z-auto relative flex-col"
      style={[{ overflow: 'visible' }, chrome.themedStyles.container]}
    >
      <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />

      {loading ? (
        <ProfileSkeleton variant={skeletonVariant} />
      ) : !profileData ? (
        <EmptyState
          customIcon={<NoUpdatesIllustration width={200} height={200} />}
          title={t('profile.notFound.title', { defaultValue: 'Profile not found' })}
          subtitle={t('profile.notFound.message', {
            defaultValue:
              "This profile couldn't be loaded. The user may not exist or their server may be unavailable.",
          })}
          action={{ label: t('common.goBack', { defaultValue: 'Go Back' }), onPress: safeBack }}
        />
      ) : (
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

          {/* Main scroll content.

              NATIVE FEED TABS: Feed's FlashList owns the scroll and receives the
              summary as `ListHeaderComponent` and the tabs as a separate sticky
              data row, keeping post rows virtualized without pinning the whole
              summary. NATIVE GRID TABS: ProfileGridList's FlashList owns the
              scroll with the same header/sticky-tab contract. The
              Animated.ScrollView remains the sole owner only for the bounded
              card tabs.

              WEB: the DOCUMENT scrolls (no inner ScrollView — that would break
              the document-scroll model the home/explore screens use). The body
              renders in normal flow inside a plain `View`; the header/banner/
              name-overlay animations read the same `scrollY`, fed by the window
              'scroll' listener in LayoutScrollContext. */}
          {IS_WEB ? (
            <View
              style={[
                { zIndex: 3 },
                chrome.themedStyles.scrollView,
                chrome.themedStyles.contentContainer,
              ]}
            >
              {summary}

              {/* Tabs — sticky in the SECOND tier, pinned flush BELOW the header
                  chrome band (`panelStickyTabsTopInset` = PANEL_TOP_INSET +
                  PANEL_HEADER_HEIGHT while framed, the same 56px offset the home
                  screen's `level={1}` tab bar uses; it collapses to just
                  PANEL_HEADER_HEIGHT at full-bleed, in lockstep with the first
                  tier). The banner fade, action cluster and compact-name overlay
                  all pin at the FIRST tier; pinning the tab bar at that same
                  inset made the two bands occupy the same vertical space and
                  OVERLAP. It lives inside the z-3 content wrapper, so `web:z-[5]`
                  keeps it above the feed content, and the `bg-background` on
                  AnimatedTabBar keeps the feed from showing through. */}
              <View className="web:sticky web:z-[5]" style={chrome.panelStickyTabsTopInset}>
                {tabBar}
              </View>

              <ProfileTabs {...tabs} />
            </View>
          ) : nativeListOwnsScroll ? (
            <View style={[{ zIndex: 3, flex: 1, minHeight: 0 }, chrome.themedStyles.scrollView]}>
              <ProfileTabs
                {...tabs}
                listOwnsScroll
                listHeaderComponent={summary}
                listStickyHeaderComponent={tabBar}
                listContentContainerStyle={chrome.themedStyles.contentContainer}
                listOnScroll={nativeGridOwnsScroll ? chrome.onScroll : undefined}
                listScrollRef={nativeGridOwnsScroll ? chrome.assignScrollRef : undefined}
              />
            </View>
          ) : (
            <Animated.ScrollView
              ref={chrome.assignScrollRef}
              showsVerticalScrollIndicator={false}
              onScroll={chrome.onScroll}
              scrollEventThrottle={16}
              style={[{ zIndex: 3 }, chrome.themedStyles.scrollView]}
              contentContainerStyle={chrome.themedStyles.contentContainer}
              stickyHeaderIndices={[1]}
              nestedScrollEnabled={true}
              removeClippedSubviews={true}
              disableIntervalMomentum={true}
              decelerationRate="normal"
            >
              {/* Summary wrapper keeps stickyHeaderIndices stable. */}
              {summary}
              {tabBar}
              <ProfileTabs {...tabs} />
            </Animated.ScrollView>
          )}

          {/* FAB that rides the BottomBar's show/hide (web mobile). */}
          <BottomBarAwareFab
            onPress={() => router.push('/compose')}
            icon={<ComposeIcon size={20} className="text-primary-foreground" />}
            accessibilityLabel={t('compose.newPost', { defaultValue: 'New post' })}
          />
        </>
      )}
    </View>
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
