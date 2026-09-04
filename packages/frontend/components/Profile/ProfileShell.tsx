import React from 'react';
import { Animated, Platform, StatusBar, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Fab } from '@oxyhq/bloom/fab';
import { EmptyState } from '@/components/common/EmptyState';
import { NoUpdatesIllustration } from '@/assets/illustrations/NoUpdates';
import { ComposeIcon } from '@/assets/icons/compose-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import type { ProfileData } from '@/hooks/useProfileData';
import { ProfileChromeLayers } from './ProfileChromeLayers';
import { ProfileSkeleton } from './ProfileSkeleton';
import { ProfileTabs } from './ProfileTabs';
import { shouldFeedOwnProfileScroll, shouldGridOwnProfileScroll } from './types';
import type { ProfileTabsProps } from './types';
import type { ProfileChrome } from './hooks/useProfileChrome';

const IS_WEB = Platform.OS === 'web';

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
 * A whole profile page rendered as ONE screen: the chrome, the scroll model and
 * the tab content together.
 *
 * Two callers, and the difference between them is worth knowing before editing
 * either. `ChannelScreen` uses this on BOTH platforms — `/c/<handle>` is a
 * single route with no sub-tabs, so a channel's tabs are local state and there
 * is no navigation for a strip to survive. `ProfileScreen` uses it on NATIVE
 * only: on web a person's chrome belongs to the `[username]` layout and each tab
 * is its own route (see `ProfileChromeFrame.tsx` for the whole seam, including
 * why native is not simply behind).
 *
 * What is genuinely common to every profile is the banner fade, the pinned
 * header band, the two sticky tiers, the compact-name overlay, the three-way
 * scroll ownership (web document / native virtualized list / native ScrollView),
 * the skeleton and not-found states, and the compose FAB. None of it depends on
 * whether the account is a person or a channel — the differences arrive as slots
 * and as {@link ProfileShellProps.banner}. The four pinned layers live in
 * {@link ProfileChromeLayers} so the web layout can render exactly the same
 * ones rather than a second copy of their z-indices and negative margins.
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
          <ProfileChromeLayers
            chrome={chrome}
            banner={banner}
            headerActions={headerActions}
            profileData={profileData}
          />

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

          {/* Clears the BottomBar on every platform — Bloom's Fab reads the
              bottom edge's occupancy, which the bar publishes. */}
          <Fab
            size={48}
            onPress={() => router.push('/compose')}
            icon={<ComposeIcon size={20} className="text-primary-foreground" />}
            accessibilityLabel={t('compose.newPost', { defaultValue: 'New post' })}
          />
        </>
      )}
    </View>
  );
}
