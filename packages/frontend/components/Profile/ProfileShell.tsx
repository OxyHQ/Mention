import { resolveProfileColor } from '@oxy.so/bloom/color-presets';
import type React from 'react';
import { Screen, type ScreenProps } from '@oxy.so/bloom/screen';
import { useState } from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { ScreenFlashList } from '@/components/common/ScreenFlashList';
import { HeaderDockProvider, StickySection, useHeaderDockInset } from '@oxy.so/bloom/layout';
import { BloomColorScope } from '@oxy.so/bloom/theme';
import { useSurfaceFill } from '@oxy.so/bloom/styles';
import { ProfileUnavailable } from './ProfileUnavailable';
import type { ProfileData } from '@/hooks/useProfileData';
import { CoverHeader } from '@oxy.so/bloom/cover-header';
import {
  ProfilePageHeader,
  PROFILE_AVATAR_OVERLAP,
  PROFILE_BANNER_HEIGHT,
} from './ProfilePageHeader';
import { ProfileSkeleton } from './ProfileSkeleton';
import { ProfileTabs } from './ProfileTabs';
import { shouldFeedOwnProfileScroll, shouldGridOwnProfileScroll } from './types';
import type { ProfileTabsProps } from './types';
import type { ProfileChrome } from './hooks/useProfileChrome';
import { useIsFocused } from '@/lib/navigation/router';

const IS_WEB = Platform.OS === 'web';

export interface ProfileShellProps {
  chrome: ProfileChrome;
  loading: boolean;
  profileData: ProfileData | null;
  /** With no profile: the account does not exist (else the lookup failed). */
  notFound: boolean;
  /** Retries a failed lookup. */
  onRetry: () => Promise<void>;
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
  /**
   * Which surface the active tab renders. Omitted when the caller renders the
   * content itself (`children`).
   */
  tabs?: ProfileTabsProps;
  /**
   * WEB: the content under the chrome, in place of `ProfileTabs` — the
   * `[username]` layout's navigator (`ProfileChromeFrame.web.tsx`). It is
   * rendered in every state, at one tree position, whether or not the chrome
   * is drawn: a navigator that moves is destroyed and rebuilt.
   */
  children?: React.ReactNode;
  /**
   * `false` draws no chrome at all, only `children` — the layout's non-tab
   * siblings (`/followers`, `/about`, …) are full screens with their own
   * header. Default `true`.
   */
  active?: boolean;
  /**
   * The account's colour, when the shell frames pages of an account it draws no
   * chrome for (`active` false): the followers list and About theme by it too.
   * Defaults to the drawn profile's own.
   */
  accentColor?: string;
  /**
   * Which anatomy the loading skeleton should hold space for. Defaults to a
   * person; a channel's page is a different shape, not a smaller one.
   */
  skeletonVariant?: 'person' | 'channel';
  /** A root tab draws no Back control (see `ProfileScreenProps.isRootTab`). */
  isRootTab?: boolean;
}

/**
 * The profile's chrome — header, banner with the summary rising into it, sticky
 * tab strip — for every platform and every caller: the native profile screen,
 * the web `[username]` layout, and channels. The banner overlap is Bloom's
 * `CoverHeader`, and nowhere else.
 */
export function ProfileShell(props: ProfileShellProps) {
  const color = resolveProfileColor(props.accentColor ?? props.profileData?.design.color);
  // A preset is the profile's `Screen` claim, which themes the whole shell (the
  // sidebar, the frame, the bottom bar) on a split layout and only this column
  // in the Deck. An exact seed has no claim, so it scopes the content alone.
  return (
    <HeaderDockProvider>
      <BloomColorScope seed={color?.seed} asChild>
        <ProfileShellBody {...props} colorPreset={color?.colorPreset} />
      </BloomColorScope>
    </HeaderDockProvider>
  );
}

function ProfileShellBody({
  style,
  chrome,
  loading,
  profileData,
  notFound,
  onRetry,
  banner,
  headerActions,
  summary,
  tabBar,
  tabs,
  children,
  active = true,
  skeletonVariant = 'person',
  isRootTab = false,
  colorPreset,
}: ProfileShellProps & Pick<ViewProps, 'style'> & Pick<ScreenProps, 'colorPreset'>) {
  const isFocused = useIsFocused();
  const surfaceFill = useSurfaceFill();
  const headerInset = useHeaderDockInset();
  const [summaryHeight, setSummaryHeight] = useState<number>();

  const nativeFeedOwnsScroll = tabs
    ? shouldFeedOwnProfileScroll({
        tab: tabs.tab,
        isWeb: IS_WEB,
        isPrivate: tabs.isPrivate,
        isOwnProfile: tabs.isOwnProfile,
      })
    : false;
  const nativeGridOwnsScroll = tabs
    ? shouldGridOwnProfileScroll({
        tab: tabs.tab,
        isWeb: IS_WEB,
        isPrivate: tabs.isPrivate,
        isOwnProfile: tabs.isOwnProfile,
      })
    : false;
  const nativeListOwnsScroll = nativeFeedOwnsScroll || nativeGridOwnsScroll;

  // Banner, summary and the tab strip under them are ONE block with one
  // background: the surface fill, which the sticky strip (Bloom's
  // StickySection) and the avatar ring paint too. Left transparent, the
  // summary showed whatever the column painted beneath it. On a framed web
  // panel that is Bloom's lit material, a shade lighter than the strip right
  // under it. The feed below keeps no background of its own and reads like
  // every other feed.
  const listHeader = (
    <View
      onLayout={IS_WEB ? undefined : (event) => setSummaryHeight(event.nativeEvent.layout.height)}
      style={{ flexGrow: 0, flexShrink: 0, backgroundColor: surfaceFill }}
    >
      {banner ? (
        <CoverHeader
          testID="profile-hero"
          coverSource={banner.uri}
          coverHeight={PROFILE_BANNER_HEIGHT}
          overlap={PROFILE_AVATAR_OVERLAP}
        >
          {summary}
        </CoverHeader>
      ) : (
        summary
      )}
    </View>
  );
  const stickyTabs = tabBar ? (
    <StickySection
      testID="profile-sticky-tabs"
      // Native: the strip's Y in the list content, which is the measured header
      // block above it. Bloom docks the page header when the strip reaches its
      // bottom edge. Passing the header inset instead made the dock progress 1
      // at rest, so the header drew docked over the banner. The list's own
      // sticky clearance is `headerInset`, below. Web measures itself.
      offset={IS_WEB ? undefined : summaryHeight}
    >
      {tabBar}
    </StickySection>
  ) : null;
  const nativeContent = tabs ? <ProfileTabs {...tabs} /> : null;
  const drawing = active && !loading ? profileData : null;
  // Native pushed routes are rendered above the tab navigator by the stack, so
  // the route must be opaque or the pager shows through while the list lays
  // out. It is painted in the surface fill, the colour of every other native
  // route (Bloom's StackScene), not the theme background it used to name. Web leaves
  // the page to the content panel, like every other screen.
  return (
    <Screen
      active={isFocused}
      scroll={active ? 'auto' : 'content'}
      colorPreset={colorPreset}
      headerPlacement={banner ? 'overlay' : 'inset'}
      header={
        drawing ? (
          <ProfilePageHeader
            profileData={drawing}
            actions={headerActions}
            overMedia={Boolean(banner)}
            showBack={!isRootTab}
          />
        ) : undefined
      }
      style={IS_WEB ? style : [style, { backgroundColor: surfaceFill }]}
    >
      {IS_WEB ? (
        <>
          {/* Flat, fixed slots: `children` stays the last child in every state. */}
          {active && loading ? <ProfileSkeleton variant={skeletonVariant} /> : null}
          {active && !loading && !profileData ? (
            <ProfileUnavailable notFound={notFound} onRetry={onRetry} />
          ) : null}
          {drawing ? listHeader : null}
          {drawing ? stickyTabs : null}
          {children ?? (drawing && tabs ? <ProfileTabs {...tabs} /> : null)}
        </>
      ) : loading ? (
        <ProfileSkeleton variant={skeletonVariant} />
      ) : !profileData ? (
        <ProfileUnavailable notFound={notFound} onRetry={onRetry} />
      ) : (
        <>
          {nativeListOwnsScroll && tabs ? (
            <View className="min-h-0 flex-1">
              <ProfileTabs
                {...tabs}
                listOwnsScroll
                listContentHeaderComponent={listHeader}
                listStickyHeaderComponent={stickyTabs}
              />
            </View>
          ) : (
            <ScreenFlashList
              data={['tabs', 'content'] as const}
              keyExtractor={(item) => item}
              renderItem={({ item }) => (item === 'tabs' ? stickyTabs : nativeContent)}
              ListHeaderComponent={listHeader}
              ListHeaderComponentStyle={{ flexGrow: 0, flexShrink: 0, alignSelf: 'stretch' }}
              onEndReached={chrome.loadMore}
              showsVerticalScrollIndicator={false}
              // The tabs are the first data row; FlashList keeps ListHeaderComponent
              // outside the data index space.
              stickyHeaderIndices={tabBar ? [0] : undefined}
              stickyHeaderConfig={{ offset: headerInset }}
            />
          )}
        </>
      )}
    </Screen>
  );
}
