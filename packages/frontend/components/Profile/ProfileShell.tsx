import React from 'react';
import { Animated, Platform, StatusBar, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { EmptyState } from '@/components/common/EmptyState';
import { NoUpdatesIllustration } from '@/assets/illustrations/NoUpdates';
import { useSafeBack } from '@/hooks/useSafeBack';
import type { ProfileData } from '@/hooks/useProfileData';
import { ProfilePageHeader, ProfileBanner, PROFILE_BANNER_HEIGHT } from './ProfilePageHeader';
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

  const listHeader = <View>{banner ? <ProfileBanner uri={banner.uri} /> : null}{summary}</View>;
  return <View className="flex-1 web:z-auto">
    <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />
    {loading ? <ProfileSkeleton variant={skeletonVariant} /> : !profileData ? (
      <EmptyState customIcon={<NoUpdatesIllustration width={200} height={200} />}
        title={t('profile.notFound.title', { defaultValue: 'Profile not found' })}
        subtitle={t('profile.notFound.message', { defaultValue: "This profile couldn't be loaded." })}
        action={{ label: t('common.goBack', { defaultValue: 'Go Back' }), onPress: safeBack }} />
    ) : <>
      <ProfilePageHeader profileData={profileData} actions={headerActions}
        revealOffset={chrome.contentHeight + (banner ? PROFILE_BANNER_HEIGHT : 0)} />
      {IS_WEB ? <>
        {listHeader}
        {tabBar}
        <ProfileTabs {...tabs} />
      </> : nativeListOwnsScroll ? <View className="min-h-0 flex-1">
        <ProfileTabs {...tabs} listOwnsScroll listHeaderComponent={listHeader}
          listStickyHeaderComponent={tabBar}
          listOnScroll={nativeGridOwnsScroll ? chrome.onScroll : undefined}
          listScrollRef={nativeGridOwnsScroll ? chrome.assignScrollRef : undefined} />
      </View> : <Animated.ScrollView ref={chrome.assignScrollRef} onScroll={chrome.onScroll}
        scrollEventThrottle={16} showsVerticalScrollIndicator={false} stickyHeaderIndices={[1]}>
        {listHeader}
        {tabBar}
        <ProfileTabs {...tabs} />
      </Animated.ScrollView>}
    </>}
  </View>;
}
