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
      style={{ overflow: 'visible' }}
    >
      {banner ? <ProfileBanner uri={banner.uri} /> : null}
      {/* The hero owns the overlap. Transforming the whole summary at this
          boundary works inside native virtualized cells as well as document
          flow on web; the negative bottom margin keeps the following tabs at
          the same measured position on both platforms. */}
      <View
        style={banner ? { marginBottom: -45, transform: [{ translateY: -45 }] } : undefined}
      >
        {summary}
      </View>
    </View>
  );
  const stickyTabs = tabBar ? (
    <StickySection testID="profile-sticky-tabs" offset={summaryHeight}>{tabBar}</StickySection>
  ) : null;
  return <View className="flex-1 web:z-auto">
    <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />
    {loading ? <ProfileSkeleton variant={skeletonVariant} /> : !profileData ? (
      <EmptyState customIcon={<NoUpdatesIllustration width={200} height={200} />}
        title={t('profile.notFound.title', { defaultValue: 'Profile not found' })}
        subtitle={t('profile.notFound.message', { defaultValue: "This profile couldn't be loaded." })}
        action={{ label: t('common.goBack', { defaultValue: 'Go Back' }), onPress: safeBack }} />
    ) : <>
      <ProfilePageHeader profileData={profileData} actions={headerActions}
        overMedia={Boolean(banner)} />
      {IS_WEB ? <>
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
        onScroll={chrome.onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={tabBar ? [0] : undefined}
        stickyHeaderConfig={{ offset: headerInset }}
      />}
    </>}
  </View>;
}
