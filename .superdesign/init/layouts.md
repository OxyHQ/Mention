# Shared route layouts
Bloom AppShell owns panel geometry and bottom navigation; route Screen owns header and scrolling.
## packages/frontend/app/_layout.tsx
```tsx
// Import Reanimated early so it initializes before other modules.
import 'react-native-reanimated';
import { enableFreeze } from 'react-native-screens';
import { registerChunkErrorRecovery } from '@/lib/chunkReload';
import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { preventNativeSplashAutoHide } from '@oxy.so/expo-splash';
import { useEffect, useState } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { AVATAR_RUNTIME_REVISION } from '@oxy.so/bloom-avatar-native/runtime-revision';
import { expoRouterScrollAdapter } from '@oxy.so/bloom/scroll/expo-router';
import { useBackWithFallback } from '@oxy.so/bloom/panel-routing/expo-router';
import { APP_DEFAULT_COLOR_PRESET } from '@/lib/colorEntitlement';

// Components
import AppSplashScreen from '@/components/AppSplashScreen';
import { NativeSplashRelease } from '@/components/NativeSplashRelease';
import { NotificationPermissionGate } from '@oxy.so/bloom/notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { notificationPermission } from '@/utils/notifications';
import { STORAGE_KEYS } from '@/lib/constants';
import { SEOHandoff } from '@/components/SEOHandoff';
import { PwaHead } from '@/components/PwaHead';
import { AppProviders } from '@/components/providers/AppProviders';
import { MentionAskProvider, useMentionAskBridge } from '@/context/MentionAskProvider';
import { MentionSettingsProvider } from '@/components/settings/MentionSettingsProvider';
import { AuthRouter } from '@/components/providers/AuthRouter';
import { OverlayInertBoundary, PortalOutlet, PortalProvider } from '@oxy.so/bloom/portal';
import { MediaFlightLayer } from '@oxy.so/bloom/media-flight';

// Hooks
import { useAppLanguage } from '@/hooks/useAppLanguage';

// Services & Utils
import { oxyServices } from '@/lib/oxyServices';
import { queryClient } from '@/lib/queryClient';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { AppInitializer } from '@/lib/appInitializer';
import { logger } from '@oxy.so/core/logger';
import { configureAppLogging } from '@/lib/logging';
import { BLOOM_THEME_PERSIST_KEY, BLOOM_THEME_STORAGE } from '@/lib/themePersistence';
import { registerSocketBfcacheRelease } from '@/lib/socketBfcache';
import { initializeWebTelemetry } from '@/lib/webTelemetry';
import { registerPendingDocuments } from '@/stores/pendingDocuments';
import { startHomeFeedBootRead } from '@/lib/bootFeedRead';

// Styles
import '../global.css';

// Install the app's level + scrubbing sink on the shared SDK logger before any
// route can emit a line.
configureAppLogging();

// The home feed's first page leaves now, not once the whole cold boot has
// rendered down to the feed; the feed takes it only for the viewer it was read
// as (see the module).
startHomeFeedBootRead();

// Freeze blurred screens so their state and scroll position survive navigation,
// and register web chunk recovery before the first route can lazy-load.
enableFreeze(true);
registerChunkErrorRecovery();

// NATIVE ONLY: hold the OS splash until the route tree has laid out — released by
// <NativeSplashRelease> below, its only owner — making the held OS splash the single
// native splash; the custom <AppSplashScreen> overlay is web-only. No-op on web.
preventNativeSplashAutoHide();

// Resolve file IDs → download URLs for Bloom's useImageResolver(). Honors the
// rendition `variant` a caller forwards. This resolver is AVATAR-ONLY in practice
// — its only consumers are Bloom's <Avatar>/<AvatarGroup> and <ZoomableAvatar>
// (post media, banners and link previews resolve through their own dedicated
// SDK paths). When a caller omits `variant`, default to the 128px
// square `avatar` crop (MEDIA_VARIANT_AVATAR) so bare-id avatars stay light.
// Larger avatars (profile header, settings) request an explicit heavier variant
// at their call site rather than relying on this default, so they are never
// shrunk here. NOTE: Bloom's <Avatar> supplies its own `variant` default, so most
// small avatars must ALSO pass an explicit variant={MEDIA_VARIANT_AVATAR} — this
// default only covers direct useImageResolver callers that omit it.
function resolveImageSource(fileId: string, variant?: string): string | undefined {
  return fileId ? oxyServices.assets.renderUrl(fileId, variant ?? MEDIA_VARIANT_AVATAR) : undefined;
}

export default function RootLayout() {
  const { askRef: aliaRef, openAlia } = useMentionAskBridge();
  // State
  const [appIsReady, setAppIsReady] = useState(false);
  // Every route screen's header offers Back: through the history, or Home when
  // a deep link left none.
  const back = useBackWithFallback('/');
  // Bloom's own strings and dates (pickers, chevrons, …) follow the app's
  // language, not the device's.
  const language = useAppLanguage();

  useEffect(() => initializeWebTelemetry(), []);

  // Release the realtime sockets while the browser holds this document in its
  // back/forward cache — an open WebSocket makes the page ineligible, which is
  // what turns a cross-document Back into a full app reload.
  useEffect(() => registerSocketBfcacheRelease(), []);
  // Link cards Clarity had not finished when a post was read arrive on their own.
  useEffect(() => registerPendingDocuments(), []);

  // React Query managers - setup once on mount
  useEffect(() => {
    // Online means "has a network", never NetInfo's reachability probe. On
    // native that probe fetches a Google URL; where it is blocked, slow or
    // behind a captive portal it reports unreachable, and React Query's
    // `networkMode: 'online'` would pause every query — feed modules and
    // who-to-follow stay on skeletons forever while Mention's own API is
    // perfectly reachable. A request that really cannot get through fails and
    // retries on its own. `null` (not yet known) counts as connected.
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      onlineManager.setOnline(state.isConnected !== false);
    });

    const onAppStateChange = (status: AppStateStatus) => {
      focusManager.setFocused(status === 'active');
    };
    const appStateSub = AppState.addEventListener('change', onAppStateChange);

    return () => {
      unsubscribeNetInfo();
      appStateSub.remove();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void AppInitializer.initializeApp(true).then((result) => {
      if (!result.success) {
        logger.error('App initialization failed', result.error);
      }
      if (!cancelled) setAppIsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Housekeeping nobody waits on starts only after the route tree is released. The
  // native splash is NOT hidden here: readiness of the startup tasks says nothing
  // about whether anything has been drawn (see <NativeSplashRelease>).
  useEffect(() => {
    if (!appIsReady) return;
    AppInitializer.runDeferredMaintenance();
  }, [appIsReady]);

  return (
    <>
      {/* WEB-only: inject the PWA manifest <link> + apple/theme metas into
          document.head at runtime (installability + Web Share Target). Mounted at
          the root so it is present on every page; renders nothing. No-op on native.
          Sits OUTSIDE <BloomProvider> on purpose: the theme provider gates its
          children while fonts load, and the manifest must not wait for that. */}
      <PwaHead />
      <SEOHandoff />
      {/* The single Bloom root — theme + haptics + image resolution + scroll
          restoration + tab-bar minimize progress. Everything Bloom renders must be
          under it: on web `useScrollRestoration()` throws outside its provider, so
          a scrollable mounted beside it (a right rail, an overlay) crashes. */}
      <BloomProvider
        characterRuntimeUrl={
          Platform.OS === 'web'
            ? undefined
            : `https://alia.onl/bloom-character/releases/${AVATAR_RUNTIME_REVISION}/runtime.mjs`
        }
        scrollAdapter={expoRouterScrollAdapter}
        back={back}
        imageResolver={resolveImageSource}
        locale={language}
        defaultMode="system"
        defaultColorPreset={APP_DEFAULT_COLOR_PRESET}
        persistKey={BLOOM_THEME_PERSIST_KEY}
        storage={BLOOM_THEME_STORAGE}
        // WEB shows the custom splash while fonts load; NATIVE shows nothing here
        // because the held OS splash is already covering the screen.
        onFontsLoading={Platform.OS === 'web' ? <AppSplashScreen /> : null}
      >
        <AppProviders oxyServices={oxyServices} queryClient={queryClient} onAskAlia={openAlia}>
          {appIsReady ? (
            <>
              {Platform.OS !== 'web' && (
                <NotificationPermissionGate
                  permission={notificationPermission}
                  storage={AsyncStorage}
                  // The key the pre-Bloom gate wrote, so people who already saw it are not asked again.
                  storageKey={STORAGE_KEYS.NOTIFICATION_EDUCATION_SHOWN}
                />
              )}
              <PortalProvider>
                {/* Wraps the OUTLET too: the Settings modal is portalled into
                    the outlet, so its pages render there, not where the
                    modal is declared. With the outlet outside, every page that
                    reads the settings context crashed on native (#1126). */}
                <MentionSettingsProvider>
                  {/* The app's own screens, and ONLY them: while a modal Bloom
                      surface (settings, a dialog, the media viewer) is open,
                      the boundary hides this subtree from TalkBack/VoiceOver
                      and makes it inert on web. The surfaces render at the
                      outlet below, so wrapping the outlet would hide them
                      too (#1126). */}
                  {/* Alia's one sheet for the whole app, loaded on first use. It
                      sits beside the inert boundary, not in it, and portals into
                      the outlet below. */}
                  <MentionAskProvider askRef={aliaRef}>
                    <OverlayInertBoundary>
                      <AuthRouter />
                    </OverlayInertBoundary>
                  </MentionAskProvider>
                  <PortalOutlet />
                  {/* The shared media surface that carries a playing video across a
                      route change. Renders null whenever nothing is in flight, so it
                      costs nothing here and never competes with the portal outlet
                      above it. It must sit at the ROOT: a flight outlives the screen
                      that started it, which is the entire point. */}
                  <MediaFlightLayer />
                  {/* Last, so it lays out in the same commit as the first screen. */}
                  {Platform.OS !== 'web' && <NativeSplashRelease />}
                </MentionSettingsProvider>
              </PortalProvider>
            </>
          ) : Platform.OS === 'web' ? (
            // WEB: the static splash covers initialization and unmounts the moment
            // it completes; no animation stands between readiness and the route
            // tree. Identity and cache ownership are gated below this point, by
            // `AccountSwitchReset` and `AuthRouter`. NATIVE renders null here —
            // the held OS splash is on top, so nothing underneath needs to paint.
            <AppSplashScreen />
          ) : null}
        </AppProviders>
      </BloomProvider>
    </>
  );
}

```

## packages/frontend/app/(app)/_layout.tsx
```tsx
import { DeckHomeEntry } from '@/components/deck/DeckHomeEntry';
import { useDeckSync } from '@/components/deck/useDeckSync';
import { DeckAddPanel } from '@/components/deck/DeckAddPanel';
import { useDeckSettings, deckRouteForSource } from '@/components/deck/deckSettings';
import { isDefaultLeadingDeckPanel } from '@/components/deck/deckEntry';
import { useLayoutEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { ExperimentalStack, Slot, usePathname } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@oxy.so/services/ui/client';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';
import {
  AppShell,
  type AppShellPanelDefinition,
  type PanelNavigationState,
} from '@oxy.so/bloom/app-shell';
import { RiQuillPenLine } from '@oxy.so/bloom/icons/RiQuillPenLine';
import { useTabPager } from '@oxy.so/bloom/tab-pager';
import { DeckColumn, DeckColumnHeaderActions } from '@/components/deck/DeckColumn';
import { useDeckAvailable } from '@/components/deck/useDeckAvailable';
import { registerPanelSurface } from '@/components/shell/panelSurface';
import { bottomBarContent } from '@/components/shell/bottomBarRoutes';

import { stackSceneLayout } from '@oxy.so/bloom/panel-routing/expo-router';
import KeyboardShortcutsModal from '@/components/KeyboardShortcutsModal';
import RegisterPush from '@/components/RegisterPushToken';
import { PushNotificationOpener } from '@/components/PushNotificationOpener';
import { RealtimePostsBridge } from '@/components/RealtimePostsBridge';
import { RealtimeNotificationsBridge } from '@/components/RealtimeNotificationsBridge';
import { PublicRealtimeBridge } from '@/components/PublicRealtimeBridge';
import { RightBar } from '@/components/RightBar';
import { useMentionSidebar } from '@/components/navigation/useMentionSidebar';
import { SignInBanner } from '@/components/SignInBanner';
import { WelcomeRedirectGate } from '@/components/WelcomeRedirectGate';
import { BootMilestone } from '@/components/BootMilestone';
import { reportBoundaryError } from '@/components/AppRootErrorBoundary';
import { usePostEngagementPanels } from '@/components/Post/postEngagementPanels';
import { postEngagementGroup } from '@/components/Post/postEngagementGroup';

import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';

const IS_WEB = Platform.OS === 'web';

function KeyboardShortcutsHost() {
  const { showHelpModal, setShowHelpModal } = useKeyboardShortcuts();
  return <KeyboardShortcutsModal visible={showHelpModal} onClose={() => setShowHelpModal(false)} />;
}

export default function AppLayout() {
  const { t } = useTranslation();
  useDeckSync();
  const sidebar = useMentionSidebar();
  const { selectTab } = useTabPager();
  const activeDeckPanel = useDeckSettings((state) => state.activePanel);
  const deckRevealPanel = useDeckSettings((state) => state.revealPanel);
  const deckViewer = useDeckSettings((state) => state.viewer);
  const deckRestorationEpoch = useDeckSettings((state) => state.restorationEpoch);
  const deckOrder = useDeckSettings((state) => state.order);
  const deckPanels = useDeckSettings((state) => state.panels);
  const updateDeckPanel = useDeckSettings((state) => state.updatePanel);
  const deckEnabled = useDeckSettings((state) => state.deckEnabled);
  const hasDefaultLeadingPanel = useDeckSettings(isDefaultLeadingDeckPanel);
  const { user, isAuthenticated, isAuthResolved } = useAuth();
  const engagementViewer = user?.id ? `user:${user.id}` : 'anonymous';
  const engagementState = usePostEngagementPanels();
  useLayoutEffect(() => {
    if (isAuthResolved) usePostEngagementPanels.getState().activate(engagementViewer);
  }, [engagementViewer, isAuthResolved]);
  useLayoutEffect(() => {
    if (isAuthResolved) {
      usePostEngagementPanels
        .getState()
        .retainHosts(engagementViewer, engagementState.generation, [
          'main',
          ...deckOrder.filter((id) => deckPanels[id]),
        ]);
    }
  }, [engagementViewer, engagementState.generation, isAuthResolved, deckOrder, deckPanels]);
  useLayoutEffect(
    () => () => {
      usePostEngagementPanels
        .getState()
        .retainHosts(engagementViewer, engagementState.generation, []);
    },
    [engagementViewer, engagementState.generation],
  );
  const withEngagement = (host: AppShellPanelDefinition, documentWhenAlone = false) => {
    const entry =
      isAuthResolved && engagementState.viewer === engagementViewer
        ? engagementState.panels[host.id]
        : undefined;
    return postEngagementGroup(
      host,
      entry,
      () =>
        usePostEngagementPanels
          .getState()
          .close(engagementViewer, engagementState.generation, host.id),
      () => {
        if (entry) {
          usePostEngagementPanels
            .getState()
            .completeClose(
              engagementViewer,
              engagementState.generation,
              host.id,
              entry.destination,
            );
        }
      },
      entry?.destination.kind === 'insights'
        ? t('insights.post.title')
        : entry?.destination.kind === 'boosts'
          ? t('post.boostsTitle', { defaultValue: 'Reposts' })
          : t('post.likesTitle', { defaultValue: 'Likes' }),
      reportBoundaryError,
      documentWhenAlone,
    );
  };
  const pathname = usePathname();
  const deckAvailable = useDeckAvailable();
  const deckOpen = (pathname === '/deck' || deckEnabled) && deckAvailable;
  const firstDeckId = deckOrder[0];
  const onInsightsRoute =
    pathname === '/insights' ||
    pathname === '/insights/weekly_recap' ||
    /^\/c\/[^/]+\/insights$/.test(pathname);

  // Same center content on both platforms; only the host differs. WEB uses <Slot/>
  // so the route flows in document scroll (the BODY is the scroller) and sticky
  // works — a <Stack>'s viewport-clamped scene would break document scroll + sticky.
  // NATIVE uses Expo Router's predictive-back-aware stack. The standard Stack
  // cannot consume Android's predictive callback and lets the Activity close;
  // all native stacks must use ExperimentalStack together on Android.
  const centerContent = (
    <>
      {IS_WEB ? (
        <DeckHomeEntry>
          <Slot />
        </DeckHomeEntry>
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

  // The shell draws its navigation from Mention's destinations
  // (`MentionNavigation`); the anonymous invitation belongs to the main panel's
  // Bloom footer. Which of them shows follows the route and the session; Bloom hides
  // both under the keyboard.
  const bottomContent = bottomBarContent({ pathname, isAuthenticated, isAuthResolved });

  // The app-shell contexts this subtree reads (videos rail, video playback,
  // navigation) are mounted by <AppShellProviders>
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
      <AppShell
        testID="mention-shell"
        variant="feed"
        scroll={IS_WEB ? 'document' : 'page'}
        drawer="reveal"
        sidebar={sidebar}
        // The sidebar's compose row and the bar's FAB: the composer page.
        primaryAction={{
          icon: RiQuillPenLine,
          accessibilityLabel: t('sidebar.compose'),
          onPress: () => selectTab('write'),
        }}
        header={null}
        navigationAlign="content"
        navigationGap={0}
        gutter={8}
        bottomBar={bottomContent === 'tabs' ? undefined : null}
        bottomBarVisibility="compact"
        // Native content scrolls under the floating bar (Bloom's scrollers pad
        // their end clear of it); the web document reserves it, except under
        // the full-bleed camera.
        reserveBottomBarSpace={IS_WEB && pathname !== '/camera'}
        panelLayout={{
          mode: deckOpen ? 'deck' : 'split',
          onPanelOrderChange: deckOpen
            ? (order) => {
                const current = useDeckSettings.getState();
                if (
                  current.viewer === deckViewer &&
                  current.restorationEpoch === deckRestorationEpoch
                )
                  current.reorderPanels(order);
              }
            : undefined,
          revealPanel: deckOpen ? deckRevealPanel : undefined,
          trailingAction: deckOpen ? <DeckAddPanel /> : undefined,
          widths: Object.fromEntries(
            Object.entries(deckPanels).map(([id, panel]) => [id, panel.width]),
          ),
          flow: deckOpen || !IS_WEB ? 'bounded' : 'document',
          appearance: 'separated',
          gap: deckOpen ? undefined : 0,
          activePanel:
            deckOpen &&
            activeDeckPanel &&
            !(hasDefaultLeadingPanel && activeDeckPanel === firstDeckId)
              ? activeDeckPanel
              : 'main',
          expandedPanel: !deckOpen && onInsightsRoute ? 'main' : undefined,
          panels: [
            withEngagement(
              {
                id: 'main',
                visible: true,
                // A screen that throws fails inside its panel, never the whole app;
                // navigating to another route recovers it.
                errorBoundary: { resetKey: pathname, onError: reportBoundaryError },
                // The Expo child navigator keeps the same host across every layout mode,
                // including the Deck entry link that opens the home route.
                keepMounted: true,
                bottomBar: bottomContent === 'sign-in' ? <SignInBanner /> : undefined,
                width: deckOpen ? 390 : 620,
                minWidth: deckOpen ? 390 : 0,
                maxWidth: deckOpen ? 390 : undefined,
                resizable: false,
                content: (
                  <>
                    <View
                      style={StyleSheet.absoluteFill}
                      pointerEvents="box-none"
                      ref={registerPanelSurface}
                    />
                    {centerContent}
                  </>
                ),
              },
              IS_WEB && !deckOpen,
            ),
            {
              id: 'context',
              visible: !deckOpen,
              errorBoundary: { onError: reportBoundaryError },
              sticky: true,
              width: 350,
              hideBelow: 990,
              appearance: pathname === '/videos' ? 'solid' : 'plain',
              chrome: 'none',
              scroll: 'content',
              content: <RightBar />,
            },
            ...deckOrder
              .filter((id) => deckPanels[id])
              .map((id) => {
                const panel = deckPanels[id];
                return withEngagement({
                  id,
                  visible: deckOpen && !(hasDefaultLeadingPanel && id === firstDeckId),
                  errorBoundary: { onError: reportBoundaryError },
                  width: panel.width,
                  appearance: panel.appearance,
                  colorPreset: panel.colorPreset,
                  onWidthChange: (width: number) => {
                    const current = useDeckSettings.getState();
                    if (
                      current.viewer === deckViewer &&
                      current.restorationEpoch === deckRestorationEpoch
                    )
                      updateDeckPanel(id, { width });
                  },
                  minWidth: 300,
                  maxWidth: 620,
                  resizable: panel.resizable,
                  reorderable: true,
                  reorderLabel: t(`deck.sources.${panel.source}`),
                  scroll: 'content' as const,
                  headerActions: <DeckColumnHeaderActions panelId={id} />,
                  navigation: {
                    initialEntries: [{ key: 'root', ...deckRouteForSource(panel.source) }],
                    state: panel.navigation ?? {
                      entries: [{ key: 'root', ...deckRouteForSource(panel.source) }],
                      index: 0,
                    },
                    scrollRestoration: {
                      scopeKey: `${deckViewer}:${deckRestorationEpoch}`,
                      initialSnapshot: panel.scrollOffsets,
                      onSnapshotChange: (scrollOffsets: Readonly<Record<string, number>>) => {
                        const current = useDeckSettings.getState();
                        if (
                          current.viewer === deckViewer &&
                          current.restorationEpoch === deckRestorationEpoch
                        )
                          updateDeckPanel(id, { scrollOffsets: { ...scrollOffsets } });
                      },
                    },
                    onNavigationChange: (navigation: PanelNavigationState) => {
                      const current = useDeckSettings.getState();
                      if (
                        current.viewer === deckViewer &&
                        current.restorationEpoch === deckRestorationEpoch
                      )
                        updateDeckPanel(id, { navigation });
                    },
                    render: () => <DeckColumn panelId={id} />,
                  },
                });
              }),
          ],
        }}
      />
      <RegisterPush />
      <PushNotificationOpener />
      <BootMilestone name="route-mounted" />
      <WelcomeRedirectGate />
      {Platform.OS === 'web' && <KeyboardShortcutsHost />}
    </>
  );
}

```

## packages/frontend/app/(app)/(tabs)/_layout.tsx
```tsx
/**
 * The five root pages — camera, Home, Videos, the composer, Notifications and
 * the profile — as Bloom's tab pager: swiped between on native, routed in place
 * on web. The pages themselves are declared in `MentionTabPager`.
 */
export { TabPagerLayout as default } from '@oxy.so/bloom/tab-pager/expo-router';

```

## packages/frontend/components/navigation/useMentionSidebar.tsx
```tsx
import { useMemo } from 'react';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { useDeckAvailable } from '@/components/deck/useDeckAvailable';
import { useDeckSettings } from '@/components/deck/deckSettings';
import { useAppShell } from '@oxy.so/bloom/app-shell';
import type { SidebarProps } from '@oxy.so/bloom/sidebar';
import { useTabPager } from '@oxy.so/bloom/tab-pager';
import { ProfileButton } from '@oxy.so/services/ui/client';
import type { AccountDialogMenuItem } from '@oxy.so/services';
import { RiDashboardLine } from '@oxy.so/bloom/icons/RiDashboardLine';
import { RiHome5Line } from '@oxy.so/bloom/icons/RiHome5Line';
import { LogoIcon } from '@/assets/logo';
import { useTheme } from '@oxy.so/bloom/theme';

/**
 * The account control at the foot of the sidebar. It is the app's own content
 * in the drawer, not a row Bloom draws, so it closes the drawer itself before
 * going anywhere.
 */
function MentionSidebarFooter({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { selectDestination } = useTabPager();
  const { closeDrawer } = useAppShell();
  const menuItems = useMemo<AccountDialogMenuItem[]>(
    () => [
      {
        key: 'mention-settings',
        label: t('sidebar.accountMenu.settings'),
        icon: 'cog-outline',
        onPress: () => {
          closeDrawer();
          selectDestination('settings');
        },
      },
      {
        key: 'mention-memberships',
        label: t('memberships.title', 'Memberships'),
        icon: 'people-outline',
        onPress: () => {
          closeDrawer();
          router.navigate('/memberships');
        },
      },
      {
        key: 'mention-plus',
        label: t('sidebar.accountMenu.plus'),
        icon: 'crown-outline',
        onPress: () => {
          closeDrawer();
          router.navigate('/plus');
        },
      },
    ],
    [t, closeDrawer, selectDestination, router],
  );
  return (
    <ProfileButton
      expanded={!collapsed}
      menuItems={menuItems}
      onNavigateProfile={() => {
        closeDrawer();
        selectDestination('you');
      }}
      onBeforeAddAccount={closeDrawer}
    />
  );
}

// The chrome around the sidebar's rows. The rows themselves, their selection,
// badges and the compose action are Mention's destinations, which Bloom's app
// shell draws (`MentionNavigation`); the drawer closes itself on a choice made
// in its rows or on the logo.
export function useMentionSidebar(): SidebarProps {
  const { t } = useTranslation();
  const deckAvailable = useDeckAvailable();
  const deckEnabled = useDeckSettings((state) => state.deckEnabled);
  const { selectDestination } = useTabPager();
  const { colors } = useTheme();

  return {
    surface: 'plain',
    size: 'md',
    contentAlignment: 'center',
    showSearch: false,
    showThemeToggle: false,
    logo: {
      icon: <LogoIcon size={28} color={colors.text} />,
      accessibilityLabel: 'Mention',
      onPress: () => selectDestination('index'),
    },
    modes: deckAvailable
      ? [
          {
            key: 'standard',
            label: t('deck.mode.standard', 'Standard'),
            icon: RiHome5Line,
          },
          { key: 'deck', label: 'Deck', icon: RiDashboardLine },
        ]
      : undefined,
    mode: deckEnabled ? 'deck' : 'standard',
    modesPresentation: 'toggle',
    modesLabel: t('deck.mode.label', 'Deck mode'),
    onModeChange: (mode) => useDeckSettings.getState().setDeckEnabled(mode === 'deck'),
    footer: ({ collapsed }) => <MentionSidebarFooter collapsed={collapsed} />,
  };
}

```
## packages/frontend/components/navigation/MentionNavigation.tsx
```tsx
import { useCallback, useMemo, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { useHaptics } from '@oxy.so/bloom/hooks';
import { RiBookmarkFill } from '@oxy.so/bloom/icons/RiBookmarkFill';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiGroupFill } from '@oxy.so/bloom/icons/RiGroupFill';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiHashtag } from '@oxy.so/bloom/icons/RiHashtag';
import { RiHome5Fill } from '@oxy.so/bloom/icons/RiHome5Fill';
import { RiHome5Line } from '@oxy.so/bloom/icons/RiHome5Line';
import { RiListUnordered } from '@oxy.so/bloom/icons/RiListUnordered';
import { RiMegaphoneFill } from '@oxy.so/bloom/icons/RiMegaphoneFill';
import { RiMegaphoneLine } from '@oxy.so/bloom/icons/RiMegaphoneLine';
import { RiNotification3Fill } from '@oxy.so/bloom/icons/RiNotification3Fill';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { RiSearchFill } from '@oxy.so/bloom/icons/RiSearchFill';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { RiSettings3Fill } from '@oxy.so/bloom/icons/RiSettings3Fill';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiVideoFill } from '@oxy.so/bloom/icons/RiVideoFill';
import { RiVideoLine } from '@oxy.so/bloom/icons/RiVideoLine';
import type { AppDestination } from '@oxy.so/bloom/tab-pager';
import { TabPagerProvider } from '@oxy.so/bloom/tab-pager/expo-router';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { requestSettings } from '@/components/settings/settingsRoutes';
import { useCommunitiesPreview } from '@/hooks/useCommunitiesPreview';
import { useUnreadCount } from '@/hooks/useUnreadCount';

/** The reader's own avatar, at whatever box the bar or the sidebar asks for. */
function ProfileAvatar({ width }: { width?: number }) {
  const { user } = useAuth();
  return (
    <AccountAvatar
      account={user ?? undefined}
      size={width ?? 26}
      source={user?.avatar}
      // Photo-less accounts get their initial, as in the Oxy account menu.
      name={user?.name?.displayName || user?.username || undefined}
      variant={MEDIA_VARIANT_AVATAR}
    />
  );
}

/**
 * Every place Mention's navigation leads, declared once. Bloom draws the rest
 * from it: the pager's pages, the bottom bar, and the app shell's sidebar with
 * its selection, badges and drawer.
 *
 * The pages, in pager order: the camera left of Home with no item anywhere —
 * reached by swiping right off the feed, as on Instagram, and never preloaded
 * (a neighbour would hold the sensor open behind the feed) — and the composer
 * last, past Profile on the side of the bar's FAB, mounted only when opened.
 * On web the profile is the viewer's own `/@handle`; on native it is `/you`.
 * The sidebar lists Profile second, right after Home (`sidebarAfter`).
 */
export function useMentionDestinations(): AppDestination[] {
  const { t } = useTranslation();
  const { user, showBottomSheet } = useAuth();
  const haptic = useHaptics();
  const unreadCount = useUnreadCount();
  const communitiesPreview = useCommunitiesPreview();
  const username = user?.username;
  const openAccounts = useCallback(() => {
    haptic('heavy');
    showBottomSheet?.('ManageAccount');
  }, [haptic, showBottomSheet]);

  return useMemo<AppDestination[]>(
    () => [
      { name: 'camera', href: '/camera', page: true },
      {
        name: 'index',
        href: '/',
        bar: true,
        preload: true,
        label: t('sidebar.home'),
        icon: RiHome5Line,
        activeIcon: RiHome5Fill,
      },
      {
        name: 'explore',
        href: '/explore',
        label: t('sidebar.explore'),
        icon: RiSearchLine,
        activeIcon: RiSearchFill,
      },
      {
        name: 'videos',
        href: '/videos',
        bar: true,
        preload: true,
        label: t('sidebar.videos'),
        icon: RiVideoLine,
        activeIcon: RiVideoFill,
      },
      {
        name: 'notifications',
        href: '/notifications',
        bar: true,
        preload: true,
        label: t('sidebar.notifications'),
        icon: RiNotification3Line,
        activeIcon: RiNotification3Fill,
        badge: unreadCount,
      },
      {
        name: 'live-rooms',
        href: '/live-rooms',
        label: t('sidebar.liveRooms'),
        icon: RiBroadcastLine,
      },
      {
        name: 'channels',
        href: '/channels',
        label: t('sidebar.channels'),
        icon: RiMegaphoneLine,
        activeIcon: RiMegaphoneFill,
      },
      ...(communitiesPreview
        ? [
            {
              name: 'communities',
              href: '/communities',
              label: t('sidebar.communities', { defaultValue: 'Communities' }),
              icon: RiGroupLine,
              activeIcon: RiGroupFill,
            },
          ]
        : []),
      {
        name: 'saved',
        href: '/saved',
        label: t('sidebar.saved'),
        icon: RiBookmarkLine,
        activeIcon: RiBookmarkFill,
      },
      { name: 'feeds', href: '/feeds', label: t('sidebar.feeds'), icon: RiHashtag },
      { name: 'lists', href: '/lists', label: t('sidebar.lists'), icon: RiListUnordered },
      {
        name: 'you',
        href: Platform.OS === 'web' && username ? `/@${username}` : '/you',
        bar: true,
        preload: true,
        // A signed-out reader has no profile to go to.
        sidebar: Boolean(user),
        // Second in the sidebar, right after Home; last in the bar, by the FAB.
        sidebarAfter: 'index',
        label: t('sidebar.profile'),
        icon: ProfileAvatar,
        onLongPress: openAccounts,
      },
      {
        // A sheet, not a page.
        name: 'settings',
        href: '/settings',
        label: t('sidebar.settings'),
        icon: RiSettings3Line,
        activeIcon: RiSettings3Fill,
        // Through the settings channel: the dialog's provider mounts below this
        // navigation.
        onPress: () => requestSettings('/settings'),
      },
      { name: 'write', href: '/write', page: true },
    ],
    [t, unreadCount, communitiesPreview, username, user, openAccounts],
  );
}

/**
 * Bloom's navigation over Mention's destinations; mounted above the app shell.
 * Pressing the place already in front takes the reader back to the top of it,
 * then reloads.
 */
export function MentionNavigation({ children }: { children: ReactNode }) {
  const { user, isAuthResolved, canUsePrivateApi } = useAuth();
  const { activeSessionId } = useOxy();
  // A predictive gesture cannot commit history from a different account or
  // session, including a new session belonging to the same account.
  const navigationScopeKey = JSON.stringify([
    isAuthResolved,
    canUsePrivateApi,
    user?.id ?? null,
    activeSessionId ?? null,
  ]);
  return (
    <TabPagerProvider
      destinations={useMentionDestinations()}
      navigationScopeKey={navigationScopeKey}
    >
      {children}
    </TabPagerProvider>
  );
}

```
