import React, { useState } from 'react';
import { Platform, StatusBar, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { HeaderDockProvider, StickySection, useHeaderDockInset } from '@oxy.so/bloom/layout';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { EmptyState } from '@/components/common/EmptyState';
import { NoUpdatesIllustration } from '@/assets/illustrations/NoUpdates';
import { useSafeBack } from '@/hooks/useSafeBack';
import type { ProfileData } from '@/hooks/useProfileData';
import { ProfilePageHeader, ProfileBanner } from './ProfilePageHeader';
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

/** Preserves native list ownership and web document flow without a second chrome layer. */
export function ProfileShell(props: ProfileShellProps) {
  const { scrollPosition } = useLayoutScroll();
  return <HeaderDockProvider scrollY={scrollPosition}><ProfileShellBody {...props} /></HeaderDockProvider>;
}

function ProfileShellBody({
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
  const headerInset = useHeaderDockInset();
  const [summaryHeight, setSummaryHeight] = useState<number>();

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

  const listHeader = (
    <View
      onLayout={IS_WEB ? undefined : event => setSummaryHeight(event.nativeEvent.layout.height)}
      style={{ overflow: 'visible', flexGrow: 0, flexShrink: 0 }}
    >
      {banner ? <ProfileBanner uri={banner.uri} /> : null}
      {/* The hero owns the overlap. Transforming the whole summary at this
          boundary works inside native virtualized cells as well as document
          flow on web; its layout height stays intact for the tab list. */}
      <View
        style={banner ? { transform: [{ translateY: -45 }] } : undefined}
      >
        {summary}
      </View>
    </View>
  );
  const stickyTabs = tabBar ? (
    <StickySection
      testID="profile-sticky-tabs"
      // Web measures the section's document position. Native virtualized lists
      // already place the row after the summary; their offset is only the
      // overlay header inset. Passing the summary height here makes FlashList
      // reserve that height a second time and creates the large native gap.
      offset={IS_WEB ? summaryHeight : headerInset}
    >
      {tabBar}
    </StickySection>
  ) : null;
  // Native pushed routes are rendered above the tab navigator by the stack. The
  // route surface must be opaque, otherwise the mounted tab pager remains
  // visible through the profile while its list is laying out (and every
  // profile row appears to overlap the feed underneath). Web already paints
  // the document surface through AppShell; native needs this route boundary to
  // publish the same Bloom surface explicitly.
  return <View className="flex-1 web:z-auto" style={{ backgroundColor: theme.colors?.background }}>
    <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />
    {loading ? <ProfileSkeleton variant={skeletonVariant} /> : !profileData ? (
      <EmptyState customIcon={<NoUpdatesIllustration width={200} height={200} />}
        title={t('profile.notFound.title', { defaultValue: 'Profile not found' })}
        subtitle={t('profile.notFound.message', { defaultValue: "This profile couldn't be loaded." })}
        action={{ label: t('common.goBack', { defaultValue: 'Go Back' }), onPress: safeBack }} />
    ) : <>
      {IS_WEB ? <>
        <ProfilePageHeader profileData={profileData} actions={headerActions}
          overMedia={Boolean(banner)} />
        {listHeader}
        {stickyTabs}
        <ProfileTabs {...tabs} />
      </> : nativeListOwnsScroll ? <View className="min-h-0 flex-1">
        <ProfileTabs {...tabs} listOwnsScroll listHeaderComponent={listHeader}
          listStickyHeaderComponent={stickyTabs}
          listOnScroll={nativeGridOwnsScroll ? chrome.onScroll : undefined}
          listScrollRef={nativeGridOwnsScroll ? chrome.assignScrollRef : undefined} />
      </View> : <FlashList
          ref={chrome.assignScrollRef}
          data={['tabs', 'content'] as const}
          keyExtractor={item => item}
          renderItem={({ item }) => item === 'tabs' ? stickyTabs : <ProfileTabs {...tabs} />}
          ListHeaderComponent={listHeader}
          ListHeaderComponentStyle={{ flexGrow: 0, flexShrink: 0, alignSelf: 'stretch' }}
          onScroll={chrome.onScroll}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          // The summary is the list header at index 0; the tab section is the
          // first data row at index 1.
          stickyHeaderIndices={tabBar ? [listHeader ? 1 : 0] : undefined}
          stickyHeaderConfig={{ offset: headerInset }}
        />}
      {!IS_WEB ? <ProfilePageHeader profileData={profileData} actions={headerActions}
        overMedia={Boolean(banner)} /> : null}
    </>}
  </View>;
}
