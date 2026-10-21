# Shared layout
Profile chrome survives web tab changes; native ProfileShell owns content scroll.
## packages/frontend/components/Profile/ProfileTabBarRow.tsx
```tsx
import React from 'react';
import { TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { RiGitMergeLine } from '@oxy.so/bloom/icons/RiGitMergeLine';
import { useSurfaceFill } from '@oxy.so/bloom/styles';
import { useTheme } from '@oxy.so/bloom/theme';

export interface ProfileTabBarRowProps {
  /** The strip itself — a routed one on web, a locally-driven one on native. */
  children: React.ReactNode;
  /** Shows the way in to the viewer's lanes. Own profile only. */
  showLanes: boolean;
}

/**
 * The row the profile's tab strip sits in.
 *
 * It carries the hairline rather than the strip does, so the border stays
 * continuous under the lanes button, which sits OUTSIDE the strip's own scroller
 * (a strip that scrolls must not scroll the button away). The button belongs
 * beside these tabs because a lane's whole effect is on which of them a post
 * lands on, and because the composer's lane icon was otherwise the only door to
 * the screen that manages them.
 *
 * Shared because the two platforms put different strips in it — see
 * `ProfileChromeFrame.tsx` — and the row around them is the part that is
 * genuinely the same.
 */
export function ProfileTabBarRow({ children, showLanes }: ProfileTabBarRowProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  // Opaque in the column's own colour: the row pins over the scrolling profile
  // feed, so it matches the surface rather than naming one.
  const surfaceFill = useSurfaceFill();
  return (
    <View
      className="flex-row items-center border-b border-border"
      style={{ backgroundColor: surfaceFill }}
    >
      <View className="flex-1" style={{ minWidth: 0 }}>
        {children}
      </View>
      {showLanes ? (
        <TouchableOpacity
          onPress={() => router.push('/lanes')}
          activeOpacity={0.7}
          accessibilityRole="link"
          accessibilityLabel={t('lanes.title', { defaultValue: 'Lanes' })}
          className="px-3 py-2.5"
        >
          <RiGitMergeLine size="md" fill={colors.textSecondary} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

```

## packages/frontend/components/Profile/ProfilePageHeader.tsx
```tsx
import React from 'react';
import { Platform } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useSafeBack } from '@/hooks/useSafeBack';
import type { ProfileData } from '@/hooks/useProfileData';
import UserName from '@/components/UserName';

/** The banner band's height. */
export const PROFILE_BANNER_HEIGHT = 170;
/** How far the summary rises into the banner: half the 90px avatar. */
export const PROFILE_AVATAR_OVERLAP = 45;
/** The ring that cuts the avatar out of the banner, as thick as X draws it. */
export const PROFILE_AVATAR_RING = 4;

/**
 * Where the tab strip starts on a profile with a banner: the summary begins
 * `PROFILE_AVATAR_OVERLAP` short of the banner's bottom edge.
 */
export function profileTabsOffset(summaryHeight: number): number {
  return PROFILE_BANNER_HEIGHT - PROFILE_AVATAR_OVERLAP + summaryHeight;
}

/** Profile identity is product content; Bloom owns its scroll-revealed header. */
export function ProfilePageHeader({
  profileData,
  actions,
  overMedia = true,
  showBack = true,
}: {
  profileData: ProfileData;
  actions: React.ReactNode;
  overMedia?: boolean;
  /**
   * `false` on a root tab. Bloom's `PageHeader` draws Back whenever it is handed
   * an `onBack`, and a root tab has nowhere to go back to.
   */
  showBack?: boolean;
}) {
  const safeBack = useSafeBack();
  return (
    <PageHeader
      title={<UserName name={profileData.design.displayName} verified={profileData.verified} />}
      titleReveal="onDock"
      presentation="floating"
      // Native lists paint their viewport above preceding siblings. Bloom's
      // overlay placement creates the measured native chrome layer so the header
      // remains above the banner/list; web keeps document overlap for its sticky
      // flow geometry.
      placement={overMedia ? (Platform.OS === 'web' ? 'overlap' : 'overlay') : 'inline'}
      testID="profile-page-header"
      onBack={showBack ? safeBack : undefined}
      actions={actions}
    />
  );
}

```

## packages/frontend/components/Profile/ProfileShell.tsx
```tsx
import React, { useState } from 'react';
import { Platform, StatusBar, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { HeaderDockProvider, StickySection, useHeaderDockInset } from '@oxy.so/bloom/layout';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { useTheme } from '@oxy.so/bloom/theme';
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
  const { scrollPosition } = useLayoutScroll();
  return (
    <HeaderDockProvider scrollY={scrollPosition}>
      <ProfileShellBody {...props} />
    </HeaderDockProvider>
  );
}

function ProfileShellBody({
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
}: ProfileShellProps) {
  const theme = useTheme();
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
  // route (StackScene), not the theme background it used to name. Web leaves
  // the page to the content panel, like every other screen.
  return (
    <View
      className="flex-1 web:z-auto"
      style={IS_WEB ? undefined : { backgroundColor: surfaceFill }}
    >
      <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />
      {IS_WEB ? (
        <>
          {/* Flat, fixed slots: `children` stays the last child in every state. */}
          {active && loading ? <ProfileSkeleton variant={skeletonVariant} /> : null}
          {active && !loading && !profileData ? (
            <ProfileUnavailable notFound={notFound} onRetry={onRetry} />
          ) : null}
          {drawing ? (
            <ProfilePageHeader
              profileData={drawing}
              actions={headerActions}
              overMedia={Boolean(banner)}
              showBack={!isRootTab}
            />
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
                listOnScroll={nativeGridOwnsScroll ? chrome.onScroll : undefined}
                listScrollRef={nativeGridOwnsScroll ? chrome.assignScrollRef : undefined}
              />
            </View>
          ) : (
            <FlashList
              ref={chrome.assignScrollRef}
              data={['tabs', 'content'] as const}
              keyExtractor={(item) => item}
              renderItem={({ item }) => (item === 'tabs' ? stickyTabs : nativeContent)}
              ListHeaderComponent={listHeader}
              ListHeaderComponentStyle={{ flexGrow: 0, flexShrink: 0, alignSelf: 'stretch' }}
              onScroll={chrome.onScroll}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              // The tabs are the first data row; FlashList keeps ListHeaderComponent
              // outside the data index space.
              stickyHeaderIndices={tabBar ? [0] : undefined}
              stickyHeaderConfig={{ offset: headerInset }}
            />
          )}
          <ProfilePageHeader
            profileData={profileData}
            actions={headerActions}
            overMedia={Boolean(banner)}
            showBack={!isRootTab}
          />
        </>
      )}
    </View>
  );
}

```

## packages/frontend/components/Profile/ProfileChromeFrame.web.tsx
```tsx
import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { router, usePathname, type Href } from 'expo-router';
import { BloomColorScope } from '@oxy.so/bloom/theme';
import { RouterTabs, type RouterTabItem } from '@oxy.so/bloom/tabs/expo-router';

import { profileTabsOffset } from './ProfilePageHeader';
import { ProfileShell } from './ProfileShell';
import { ProfileTabBarRow } from './ProfileTabBarRow';
import { usePersonProfileView } from './hooks/usePersonProfileView';
import { useRoutedProfileUsername } from './hooks/useRoutedProfileUsername';
import { profileTabHref, profileTabSelectionFromPathname } from './profileTabRoute';
import type { ProfileChromeFrameProps, ProfileTabDescriptor } from './types';

/**
 * The `[username]` layout's body — WEB, where it owns the profile chrome.
 *
 * The banner, the identity summary, the action cluster and the tab strip are
 * rendered HERE, above the `<Slot/>` that renders whichever child the URL names.
 * They are drawn by `ProfileShell` — the same chrome native and channels use —
 * with the `<Slot/>` as its content; this frame only decides what it is fed.
 * The placement is the whole fix: a strip rendered inside each tab screen is
 * unmounted by the navigation it performs, so the chrome blanked for the 597ms
 * the incoming tab's async chunk took to arrive (measured on production), the
 * skeleton that replaced it guessed the first tab was selected, and the real bar
 * snapped into place when the screen finally committed. None of that is a page
 * load — the JS context survives throughout — it is a remount, and a layout does
 * not remount. `/explore` has the identical `<Slot/>` and has never had the
 * problem, because it renders its strip in the LAYOUT.
 *
 * Back is fixed by the same move for a different reason: `RouterTabs` PUSHES, so
 * each tab is a history entry and Back returns to the tab the reader came from
 * rather than leaving the profile. The strip could not push while it lived in
 * the screens, because every entry would then rebuild it.
 *
 * See `ProfileChromeFrame.tsx` (the native half) for why the two platforms
 * differ, and why native is not simply behind.
 *
 * ## The tab routes are FLAT, and that is load-bearing
 *
 * `index.tsx`, `replies.tsx`, … and `lane/[laneId].tsx` are direct children of
 * `[username]`, beside `/followers`, `/following`, `/about`, `/connections`,
 * `/in-common` and `/who-may-know`. An earlier version of this change grouped
 * the tabs under a nested `(tabs)` segment so that a layout could wrap exactly
 * them; it shipped and was reverted. `router.push('/@handle')` from another
 * profile creates a second `[username]` entry carrying NO nested state, its
 * child navigator then has to choose an initial route, and it settled on
 * `about` — which expo-router wrote into the URL. Traced with
 * `useRootNavigationState()`, reproduced 3/3 locally and once on production.
 * `unstable_settings = { anchor: '(tabs)' }` — the router's own documented
 * mechanism for it — had no effect. So a pushed `[username]` entry's default
 * child must be a real route, and the boundary the group used to draw is drawn
 * here instead, by asking the pathname.
 *
 * ## THREE INVARIANTS, all load-bearing
 *
 *  - **`children` is rendered in EVERY branch, at ONE tree position.** It is the
 *    segment's NAVIGATOR. A layout that swaps its navigator for a plain screen
 *    leaves the segment with no navigator in the navigation state, and on web
 *    the remount that follows chases `usePathname()` until React aborts the
 *    render ("Maximum update depth exceeded", React error #185) —
 *    `[username]/_layout.tsx` carries that account. React reconciles by
 *    POSITION, so a conditional that moved it between two parents would destroy
 *    and rebuild it on every crossing into `/followers` and back; the chrome
 *    around it comes and goes instead, and the navigator never moves.
 *  - **The six non-tab siblings get NO chrome.** Each is a full screen with its
 *    own header and back arrow (`connections.tsx`, `AccountInfoScreen`), and a
 *    banner and identity summary stacked above one would be a second,
 *    contradictory chrome. `profileTabSelectionFromPathname` answers `null`
 *    there — and for any child added later that it has never heard of, which is
 *    the direction that fails safe.
 *  - **The active tab is read from the PATHNAME, not from the routed screen.**
 *    This layout owns `useProfileChrome`, and on web that hook's scroll listener
 *    is the profile's only paginator — it pages the ACTIVE tab's feed. A layout
 *    that did not know which tab is showing would page the wrong one, and
 *    nothing would fail.
 */
export default function ProfileChromeFrame({ children }: ProfileChromeFrameProps) {
  const pathname = usePathname();
  const selection = useMemo(() => profileTabSelectionFromPathname(pathname), [pathname]);
  const active = selection !== null;

  // The strip navigates on its own (it is a `RouterTabs`), so this is reached
  // only from the summary's stats row — "12 posts" jumping to the posts tab.
  // PUSH for the same reason the strip does: a jump the reader can come back
  // from.
  const onSelectTab = useCallback((_descriptor: ProfileTabDescriptor, href: Href) => {
    router.push(href);
  }, []);

  const routedUsername = useRoutedProfileUsername();

  const view = usePersonProfileView({
    active,
    activeKey: selection?.key ?? 'posts',
    onSelectTab,
    // The chrome IS the `[username]` layout's body, so the segment is its own to
    // read — and the only reader of it on this side of the fork.
    username: routedUsername,
  });

  const items = useMemo<RouterTabItem[]>(
    () =>
      view.tabDescriptors.map((descriptor) => ({
        value: descriptor.key,
        label: descriptor.label,
        href: profileTabHref(view.handle, descriptor),
      })),
    [view.tabDescriptors, view.handle],
  );

  // A wrong-family URL (a channel sitting on `/@handle`) holds the skeleton
  // rather than painting a person-shaped chrome for the frame before the routed
  // screen below redirects. The redirect itself is the screen's — see the
  // navigator invariant above.
  const loading = view.loading || view.canonicalHref !== null;

  const tabBar = (
    <ProfileTabBarRow showLanes={view.isOwnProfile}>
      <RouterTabs
        items={items}
        // The profile strip is itself horizontally scrollable — nine static tabs
        // plus one per lane — so a horizontal pan here means "scroll the strip",
        // and a swipe-to-change-tab gesture would take that drag away from it.
        swipeEnabled={false}
        // Re-tapping the tab you are on conventionally means "back to the top",
        // and here that is the top of the CONTENT rather than of the document —
        // the same place the stats row jumps to, so the two agree.
        onReselect={() => view.chrome.scrollToContent(profileTabsOffset(view.chrome.contentHeight))}
      />
    </ProfileTabBarRow>
  );

  return (
    <BloomColorScope colorPreset={active ? view.colorName : undefined} asChild>
      <View className="flex-1 web:z-auto">
        {view.seo}
        <ProfileShell
          active={active}
          chrome={view.chrome}
          loading={loading}
          profileData={view.profileData}
          notFound={view.notFound}
          onRetry={view.refresh}
          banner={{ uri: view.bannerUri }}
          headerActions={view.headerActions}
          summary={view.summary}
          tabBar={tabBar}
        >
          {/* Keep the navigator at one tree position across profile-tab and sibling routes. */}
          {children}
        </ProfileShell>
      </View>
    </BloomColorScope>
  );
}

```

## packages/frontend/app/(app)/_layout.tsx
```tsx
import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { ExperimentalStack, Slot, usePathname } from 'expo-router';

import { useAuth } from '@oxy.so/services/ui/client';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';
import { AppShell } from '@oxy.so/bloom/app-shell';
import { registerPanelSurface } from '@/components/shell/panelSurface';
import { bottomBarContent } from '@/components/shell/bottomBarRoutes';

import { MentionHomeHeader } from '@/components/navigation/MentionHomeHeader';
import { stackSceneLayout } from '@/components/navigation/StackScene';
import { BottomBar } from '@/components/BottomBar';
import KeyboardShortcutsModal from '@/components/KeyboardShortcutsModal';
import RegisterPush from '@/components/RegisterPushToken';
import { RealtimePostsBridge } from '@/components/RealtimePostsBridge';
import { RealtimeNotificationsBridge } from '@/components/RealtimeNotificationsBridge';
import { PublicRealtimeBridge } from '@/components/PublicRealtimeBridge';
import { RightBar } from '@/components/RightBar';
import { useMentionSidebar } from '@/components/navigation/useMentionSidebar';
import { useDrawer } from '@/context/DrawerContext';
import { SignInBanner } from '@/components/SignInBanner';
import WelcomeModalGate from '@/components/WelcomeModalGate';
import { BootMilestone } from '@/components/BootMilestone';

import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useKeyboardVisibility } from '@/hooks/useKeyboardVisibility';
import { useScreenColor } from '@/context/ScreenColorContext';
import { APP_COLOR_PRESETS, BloomColorScope, type AppColorName } from '@oxy.so/bloom/theme';

const IS_WEB = Platform.OS === 'web';

/**
 * Profile routes own the screen-level color scope; every other route renders with
 * the app-wide theme. Safety net: ignore any stale screenColor when the pathname
 * is outside the profile subtree (`/@username[/sub]`, `/c/<handle>[/sub]`) so
 * per-profile colors never leak into other pages.
 */
function isProfileRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  // `/you` is the viewer's own profile as a TAB — the same page, at a route with
  // no handle in it (see `(tabs)/you.tsx`). Without it here the one profile a
  // reader looks at most would be the only one rendering outside its own colour
  // scope.
  //
  // `/c/` is the same screen for a channel (`ChannelScreen` resolves its preset
  // through the same `useProfileAccount` -> `useProfileScreenColor`, which
  // publishes it here). It scopes its own subtree either way; what this adds is
  // the PANEL. Chrome reads the surface the panel painted (`useSurfaceFill`), so
  // a channel whose column was tinted from inside its own scope, on a panel
  // painted outside it, would otherwise paint the app-wide card against the
  // channel's tinted children.
  return pathname.startsWith('/@') || pathname.startsWith('/c/') || pathname === '/you';
}

/**
 * Leaf host for the web keyboard-shortcuts help modal. Owns `showHelpModal` so its
 * high-frequency toggle stays isolated from the visual shell.
 */
function KeyboardShortcutsHost() {
  const { showHelpModal, setShowHelpModal } = useKeyboardShortcuts();
  return <KeyboardShortcutsModal visible={showHelpModal} onClose={() => setShowHelpModal(false)} />;
}

export default function AppLayout() {
  const sidebar = useMentionSidebar();
  const keyboardVisible = useKeyboardVisibility();
  const drawer = useDrawer();
  const { isAuthenticated, isAuthResolved } = useAuth();
  const { screenColor } = useScreenColor();
  const pathname = usePathname();
  const onProfileRoute = isProfileRoute(pathname);

  const activeScreenColor: AppColorName | undefined =
    onProfileRoute && screenColor && APP_COLOR_PRESETS[screenColor] ? screenColor : undefined;

  // Same center content on both platforms; only the host differs. WEB uses <Slot/>
  // so the route flows in document scroll (the BODY is the scroller) and sticky
  // works — a <Stack>'s viewport-clamped scene would break document scroll + sticky.
  // NATIVE uses Expo Router's predictive-back-aware stack. The standard Stack
  // cannot consume Android's predictive callback and lets the Activity close;
  // all native stacks must use ExperimentalStack together on Android.
  const centerContent = (
    <>
      {IS_WEB ? (
        <Slot />
      ) : (
        <ExperimentalStack screenOptions={{ headerShown: false }} screenLayout={stackSceneLayout}>
          {/* The five root tabs, as ONE stack screen. Everything else in this
              group is pushed over them, which is what keeps the tabs alive
              underneath a post or a settings page and what makes Back return to
              the tab the reader came from.

              This entry replaces the one `videos` used to have. That entry
              existed so the reels screen would mount OVER the feed rather than
              replacing it: a flying video is one surface handed from origin to
              destination, so the destination must exist while the origin is
              still there, and a screen swap would unmount the feed first and
              leave the flight nothing to hand over from. Inside the tabs both
              screens are simply mounted at once, permanently — the property is
              now structural instead of a stack-attachment detail. */}
          <ExperimentalStack.Screen name="(tabs)" />
          <ExperimentalStack.Screen name="compose" />
          <ExperimentalStack.Screen name="p/[id]/boost" />
        </ExperimentalStack>
      )}
    </>
  );

  // The tab bar for a signed-in reader, the sign-in invitation for an anonymous
  // one — both pinned by the shell; see `bottomBarContent`.
  const bottomContent = bottomBarContent({
    pathname,
    keyboardVisible,
    isAuthenticated,
    isAuthResolved,
  });
  const bottomBar =
    bottomContent === 'tabs' ? (
      <BottomBar />
    ) : bottomContent === 'sign-in' ? (
      <SignInBanner />
    ) : undefined;

  // The app-shell contexts this subtree reads (screen color, videos rail, video
  // playback, drawer, bottom-bar visibility) are mounted by <AppShellProviders>
  // up in `components/providers/AppProviders.tsx`. They CANNOT live here: bottom
  // sheets and bloom's native portal outlet render their content above this
  // route, so anything mounted at this depth is invisible to them.
  return (
    <>
      {/* Connection loss shows as a Bloom toast — see @oxy.so/bloom/connection-status.
          It replaced an app-local banner that pushed the whole screen down. */}
      <ConnectionStatusToasts />
      <RealtimePostsBridge />
      <RealtimeNotificationsBridge />
      {/* Ungated on purpose: the public socket is what makes trending realtime
          for signed-out visitors, who cannot connect to the two above at all. */}
      <PublicRealtimeBridge />
      <BloomColorScope colorPreset={activeScreenColor} asChild>
        <AppShell
          variant="feed"
          scroll={IS_WEB ? 'document' : 'fixed'}
          panel
          panelColorPreset={activeScreenColor}
          drawer="reveal"
          drawerOpen={drawer.isOpen}
          onDrawerOpenChange={(open) => (open ? drawer.open() : drawer.close())}
          sidebar={sidebar}
          header={pathname === '/' ? <MentionHomeHeader /> : null}
          contentWidth={620}
          navigationAlign="content"
          navigationGap={0}
          asideGap={0}
          gutter={8}
          navFrom={500}
          navExpandedFrom={1300}
          asideFrom={990}
          asideWidth={350}
          asideCollapse="hidden"
          aside={<RightBar />}
          bottomBar={bottomBar}
          // The tab bar is navigation, so it gives way to the sidebar on wide
          // screens; the CTA has no stand-in there and shows at every width.
          bottomBarVisibility={isAuthenticated ? 'compact' : 'always'}
          reserveBottomBarSpace={pathname !== '/videos' && pathname !== '/camera'}
        >
          <View
            style={StyleSheet.absoluteFill}
            pointerEvents="box-none"
            ref={registerPanelSurface}
          />
          {centerContent}
        </AppShell>
      </BloomColorScope>
      <RegisterPush />
      <BootMilestone name="route-mounted" />
      <WelcomeModalGate appIsReady={true} />
      {Platform.OS === 'web' && <KeyboardShortcutsHost />}
    </>
  );
}

```