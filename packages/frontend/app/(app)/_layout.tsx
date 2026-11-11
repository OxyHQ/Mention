import { PostReplyNavigationContext } from '@/components/Post/PostReplyNavigationContext';
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
  const withEngagement = (
    host: AppShellPanelDefinition,
    documentWhenAlone = false,
    videoRoute = false,
  ) => {
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
      () =>
        entry &&
        usePostEngagementPanels
          .getState()
          .dismissFloating(
            engagementViewer,
            engagementState.generation,
            host.id,
            entry.destination,
          ),
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
      videoRoute || entry?.destination.kind === 'replies'
        ? t('videos.replies')
        : entry?.destination.kind === 'insights'
          ? t('insights.post.title')
          : entry?.destination.kind === 'boosts'
            ? t('post.boostsTitle', { defaultValue: 'Reposts' })
            : t('post.likesTitle', { defaultValue: 'Likes' }),
      reportBoundaryError,
      documentWhenAlone,
      videoRoute,
    );
  };
  const pathname = usePathname();
  const onVideosRoute = pathname === '/videos';
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
  const ownsMainReplyNavigation = isAuthenticated && !deckOpen && /^\/p\/[^/]+$/.test(pathname);

  // The app-shell contexts this subtree reads (video playback,
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
      <PostReplyNavigationContext.Provider value={ownsMainReplyNavigation}>
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
          bottomBar={bottomContent === 'tabs' && !ownsMainReplyNavigation ? undefined : null}
          bottomBarVisibility="compact"
          // Native content scrolls under the floating bar (Bloom's scrollers pad
          // their end clear of it); the web document reserves it, except under
          // the full-bleed camera.
          reserveBottomBarSpace={IS_WEB && pathname !== '/camera' && !ownsMainReplyNavigation}
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
                  width: deckOpen ? 390 : onVideosRoute ? 978 : 620,
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
                onVideosRoute,
              ),
              {
                id: 'context',
                visible: !deckOpen && !onVideosRoute,
                errorBoundary: { onError: reportBoundaryError },
                sticky: true,
                width: 350,
                hideBelow: 990,
                appearance: 'plain',
                chrome: 'none',
                scroll: 'content',
                content: <RightBar />,
              },
              ...deckOrder
                .filter((id) => deckPanels[id])
                .map((id) => {
                  const panel = deckPanels[id];
                  return withEngagement(
                    {
                      id,
                      visible: deckOpen && !(hasDefaultLeadingPanel && id === firstDeckId),
                      errorBoundary: { onError: reportBoundaryError },
                      width: panel.width,
                      appearance: panel.appearance,
                      colorPreset: panel.colorPreset,
                      minWidth: 300,
                      maxWidth: 620,
                      resizable: false,
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
                    },
                    false,
                    (
                      panel.navigation?.entries[panel.navigation.index]?.name ??
                      deckRouteForSource(panel.source).name
                    ).split(/[?#]/)[0] === '/videos',
                  );
                }),
            ],
          }}
        />
      </PostReplyNavigationContext.Provider>
      <RegisterPush />
      <PushNotificationOpener />
      <BootMilestone name="route-mounted" />
      <WelcomeRedirectGate />
      {Platform.OS === 'web' && <KeyboardShortcutsHost />}
    </>
  );
}
