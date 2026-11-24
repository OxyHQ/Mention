import { PostReplyNavigationContext } from '@/components/Post/PostReplyNavigationContext';
import { DeckHomeEntry } from '@/components/deck/DeckHomeEntry';
import { useDeckSync } from '@/components/deck/useDeckSync';
import { DeckAddPanel } from '@/components/deck/DeckAddPanel';
import { useDeckSettings, deckRouteForSource } from '@/components/deck/deckSettings';
import { isDefaultLeadingDeckPanel } from '@/components/deck/deckEntry';
import { useLayoutEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppLayout, layout, Sheet, Stack } from '@oxy.so/bloom-language/router';

import { useAuth } from '@oxy.so/services/ui/client';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';
import type { AppShellPanelDefinition, PanelNavigationState } from '@oxy.so/bloom/app-shell';
import { RiQuillPenLine } from '@oxy.so/bloom/icons/RiQuillPenLine';
import { DeckColumn, DeckColumnHeaderActions } from '@/components/deck/DeckColumn';
import { useDeckAvailable } from '@/components/deck/useDeckAvailable';
import { registerPanelSurface } from '@/components/shell/panelSurface';
import { bottomBarContent } from '@/components/shell/bottomBarRoutes';
import { RouteErrorBoundary } from '@/components/shell/RouteErrorBoundary';
import { ShellRouteProvider, useShellRoute } from '@/components/shell/shellRoute';
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

/**
 * The app's shell in the Bloom language: Bloom's AppShell around the app's
 * stack, which is each platform's own (the system stack on iOS, the
 * predictive-back stack on Android, the route in place on the web, where the
 * document scrolls). The five root tabs are ONE stack screen, `(tabs)`;
 * everything else in this group is pushed over them, which keeps the tabs
 * alive underneath a post or a settings page and makes Back return to the tab
 * the reader came from. A flying video is one surface handed from the feed to
 * the reels, so both stay mounted inside the tabs at once. The pushed composer
 * (`compose`: a reply, quote, edit or share) is a sheet on iOS.
 *
 * The shell's navigation is Mention's destinations (`MentionNavigation`, above
 * the shell): the sidebar's rows, the bottom bar (the system tab bar on iOS)
 * and the compose action, which is the `write` page. The panels (Deck,
 * engagement, the context column) stay Mention's own options.
 */
const MentionShell = layout(function MentionShell() {
  const { t } = useTranslation();
  useDeckSync();
  const sidebar = useMentionSidebar();
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
  // The route's facts, not its path: the shell re-renders when one of them
  // changes, not on every navigation (see `ShellRouteProvider`).
  const route = useShellRoute();
  const onVideosRoute = route.videos;
  const deckAvailable = useDeckAvailable();
  const deckOpen = (route.deck || deckEnabled) && deckAvailable;
  const firstDeckId = deckOrder[0];
  const onInsightsRoute = route.insights;

  // The anonymous invitation belongs to the main panel's Bloom footer. Whether
  // it or the bar shows follows the route and the session; Bloom hides both
  // under the keyboard.
  const bottomContent = bottomBarContent({ route, isAuthenticated, isAuthResolved });
  const ownsMainReplyNavigation = isAuthenticated && !deckOpen && route.post;

  return AppLayout(Stack('(tabs)', Sheet('compose'), 'p/[id]/boost'))
    .primaryAction(RiQuillPenLine, t('sidebar.compose'), 'write')
    .bottomBar(bottomContent === 'tabs' && !ownsMainReplyNavigation)
    .shell((navigator) => ({
      testID: 'mention-shell',
      layout: deckOpen ? 'deck' : 'feed',
      presentation: 'framed',
      drawer: 'reveal',
      sidebar,
      header: null,
      gutter: 8,
      bottomBarVisibility: 'compact',
      // Native content scrolls under the floating bar (Bloom's scrollers pad
      // their end clear of it); the web document reserves it, except under
      // the full-bleed camera.
      reserveBottomBarSpace: IS_WEB && !route.camera && !ownsMainReplyNavigation,
      panelLayout: {
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
              role: 'main',
              visible: true,
              // The Expo child navigator keeps the same host across every layout mode,
              // including the Deck entry link that opens the home route.
              keepMounted: true,
              bottomBar: bottomContent === 'sign-in' ? <SignInBanner /> : undefined,
              width: deckOpen ? 390 : onVideosRoute ? 978 : 620,
              minWidth: deckOpen ? 390 : 0,
              maxWidth: deckOpen ? 390 : undefined,
              resizable: false,
              content: (
                // A screen that throws fails inside its panel, never the whole
                // app; navigating to another route recovers it.
                <RouteErrorBoundary onError={reportBoundaryError}>
                  <View
                    style={StyleSheet.absoluteFill}
                    pointerEvents="box-none"
                    ref={registerPanelSurface}
                  />
                  <PostReplyNavigationContext.Provider value={ownsMainReplyNavigation}>
                    <DeckHomeEntry>{navigator}</DeckHomeEntry>
                  </PostReplyNavigationContext.Provider>
                </RouteErrorBoundary>
              ),
            },
            IS_WEB && !deckOpen,
            onVideosRoute,
          ),
          {
            id: 'context',
            role: 'context',
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
                  role: 'main',
                  visible: deckOpen && !(hasDefaultLeadingPanel && id === firstDeckId),
                  errorBoundary: { onError: reportBoundaryError },
                  width: panel.width,
                  appearance: panel.appearance,
                  colorPreset: panel.colorPreset,
                  minWidth: 300,
                  maxWidth: 620,
                  resizable: panel.resizable,
                  onWidthChange: (width) => {
                    const current = useDeckSettings.getState();
                    if (
                      current.viewer === deckViewer &&
                      current.restorationEpoch === deckRestorationEpoch
                    )
                      updateDeckPanel(id, { width });
                  },
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
      },
    }));
});

/**
 * The `(app)` group's layout: Mention's shell, and the app's services beside
 * it (realtime bridges, push, the welcome gate, keyboard shortcuts). The
 * app-shell contexts the shell reads (video playback, navigation) are mounted
 * by <AppShellProviders> in `components/providers/AppProviders.tsx`: bottom
 * sheets and Bloom's native portal outlet render above this route, so anything
 * mounted at this depth is invisible to them.
 */
export default function AppRoute() {
  return (
    <>
      {/* Connection loss shows as a Bloom toast — see @oxy.so/bloom/connection-status. */}
      <ConnectionStatusToasts />
      <RealtimePostsBridge />
      <RealtimeNotificationsBridge />
      {/* Ungated on purpose: the public socket is what makes trending realtime
          for signed-out visitors, who cannot connect to the two above at all. */}
      <PublicRealtimeBridge />
      <ShellRouteProvider>
        <MentionShell />
      </ShellRouteProvider>
      <RegisterPush />
      <PushNotificationOpener />
      <BootMilestone name="route-mounted" />
      <WelcomeRedirectGate />
      {IS_WEB && <KeyboardShortcutsHost />}
    </>
  );
}
