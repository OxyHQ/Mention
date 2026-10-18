import { useDeckSync } from '@/components/deck/useDeckSync';
import { DeckAddPanel } from '@/components/deck/DeckAddPanel';
import { useDeckSettings, deckRouteForSource } from '@/components/deck/deckSettings';
import { Platform, StyleSheet, View } from 'react-native';
import { ExperimentalStack, Slot, usePathname } from 'expo-router';

import { useAuth } from '@oxy.so/services/ui/client';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';
import { AppShell, type PanelNavigationState } from '@oxy.so/bloom/app-shell';
import { DeckColumn, DeckColumnHeaderActions } from '@/components/deck/DeckColumn';
import { useDeckAvailable } from '@/components/deck/useDeckAvailable';
import { registerPanelSurface } from '@/components/shell/panelSurface';
import { bottomBarContent } from '@/components/shell/bottomBarRoutes';

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

const IS_WEB = Platform.OS === 'web';

function KeyboardShortcutsHost() {
  const { showHelpModal, setShowHelpModal } = useKeyboardShortcuts();
  return <KeyboardShortcutsModal visible={showHelpModal} onClose={() => setShowHelpModal(false)} />;
}

export default function AppLayout() {
  useDeckSync();
  const sidebar = useMentionSidebar();
  const activeDeckPanel = useDeckSettings((state) => state.activePanel);
  const deckViewer = useDeckSettings((state) => state.viewer);
  const deckRestorationEpoch = useDeckSettings((state) => state.restorationEpoch);
  const deckOrder = useDeckSettings((state) => state.order);
  const deckPanels = useDeckSettings((state) => state.panels);
  const updateDeckPanel = useDeckSettings((state) => state.updatePanel);
  const keyboardVisible = useKeyboardVisibility();
  const drawer = useDrawer();
  const { isAuthenticated, isAuthResolved } = useAuth();
  const pathname = usePathname();
  const deckAvailable = useDeckAvailable();
  const onDeckRoute = pathname === '/deck' && deckAvailable;
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
      <>
        <AppShell
          testID="mention-shell"
          variant="feed"
          scroll={IS_WEB ? 'document' : 'fixed'}
          drawer="reveal"
          drawerOpen={drawer.isOpen}
          onDrawerOpenChange={(open) => (open ? drawer.open() : drawer.close())}
          sidebar={sidebar}
          header={null}
          navigationAlign="content"
          navigationGap={0}
          gutter={8}
          bottomBar={bottomBar}
          // The tab bar is navigation, so it gives way to the sidebar on wide
          // screens; the CTA has no stand-in there and shows at every width.
          bottomBarVisibility={isAuthenticated ? 'compact' : 'always'}
          reserveBottomBarSpace={pathname !== '/camera'}
          panelLayout={{
            mode: onDeckRoute ? 'deck' : 'split',
            trailingAction: onDeckRoute ? <DeckAddPanel /> : undefined,
            widths: Object.fromEntries(
              Object.entries(deckPanels).map(([id, panel]) => [id, panel.width]),
            ),
            flow: onDeckRoute || !IS_WEB ? 'bounded' : 'document',
            appearance: 'separated',
            gap: onDeckRoute ? undefined : 0,
            activePanel: onDeckRoute ? (activeDeckPanel ?? Object.keys(deckPanels)[0]) : 'main',
            expandedPanel: onInsightsRoute ? 'main' : undefined,
            panels: [
              {
                id: 'main',
                visible: !onDeckRoute,
                // The Expo child navigator keeps the same host across every layout mode,
                // including a cold open of Deck where its route screen renders null.
                keepMounted: true,
                width: 620,
                minWidth: 0,
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
              {
                id: 'context',
                visible: !onDeckRoute,
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
                  return {
                    id,
                    visible: onDeckRoute,
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
                  };
                }),
            ],
          }}
        />
      </>
      <RegisterPush />
      <BootMilestone name="route-mounted" />
      <WelcomeModalGate appIsReady={true} />
      {Platform.OS === 'web' && <KeyboardShortcutsHost />}
    </>
  );
}
