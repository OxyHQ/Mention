/**
 * AppProviders Component
 * Centralizes all provider components for better organization
 * Memoized to prevent unnecessary re-renders
 */

import React, { memo, useCallback } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { MenuProvider } from 'react-native-popup-menu';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider } from '@oxyhq/services/ui/client';
import { OxyServices } from '@oxyhq/core';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import AppSplashScreen from '@/components/AppSplashScreen';
import { AccountSwitchReset } from '@/components/providers/AccountSwitchReset';
import { AppShellProviders } from '@/components/providers/AppShellProviders';
import { BottomSheetProvider } from '@/context/BottomSheetContext';
import { HomeRefreshProvider } from '@/context/HomeRefreshContext';
import { LayoutScrollProvider } from '@/context/LayoutScrollContext';
import { OXY_CLIENT_ID, OXY_AUTH_REDIRECT_URI } from '@/config';
import { ConfirmPromptProvider } from '@/components/common/ConfirmPrompt';
import { ActionMenuHost } from '@/components/common/ActionMenu';
import { ContentDialogHost } from '@/components/common/ContentDialog';
import { FediverseInfoDialogProvider } from '@/components/Fediverse/FediverseInfoDialog';
import { ChannelInfoDialogProvider } from '@/components/Channels/ChannelInfoDialog';
import { LiveFeatureHost } from '@/components/providers/LiveFeatureProviders';
import { LiveRoomControllerProvider } from '@/context/LiveRoomContext';
import i18n from '@/lib/i18n';
import { createLogger } from '@oxyhq/core/logger';

const logger = createLogger('AppProviders');

interface AppProvidersProps {
  children: React.ReactNode;
  oxyServices: OxyServices;
  queryClient: QueryClient;
}

export const AppProviders = memo(function AppProviders({
  children,
  oxyServices,
  queryClient,
}: AppProvidersProps) {
  const handleBoundaryError = useCallback((error: Error, errorInfo: React.ErrorInfo) => {
    logger.error('Error caught by boundary', error, { errorInfo });
  }, []);

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/*
         * react-native-keyboard-controller's root provider. It MUST sit inside
         * GestureHandlerRootView and above everything that consumes
         * KeyboardContext — OxyProvider's sheets and Bloom's BottomSheet — or
         * those hooks log "Couldn't find real values for KeyboardContext" on
         * native. It is a passthrough no-op on web (the library handles the
         * platform split internally; no manual .web fork needed).
         */}
        <KeyboardProvider>
          {/*
           * `webAuthMode="popup"` keeps the SDK off the two lanes that would
           * navigate this tab away: the silent full-page `prompt=none` restore
           * on cold boot, and the post-login hub-sync bounce. Without it a
           * signed-out cold boot on a deep route leaves the origin entirely —
           * `/explore` → `auth.oxy.so/authorize` → back — which destroys every
           * bit of in-page state before the user has done anything.
           */}
          {/*
           * `backgroundSession` is what makes the FOLLOWING home-screen widget
           * possible. That widget's WorkManager worker runs with no JS runtime —
           * often with the app process dead — so it cannot reach this session at
           * all; the SDK instead provisions a purpose-built, non-rotating
           * credential while the app runs and stores it where the widget's Kotlin
           * (`so.oxy.session.OxyBackgroundSession`) can exchange it for a short
           * access token. This prop is the whole integration: no app-local token
           * helper, no manual `Authorization`.
           *
           * It cannot create a session, only extend one the user established
           * here, and every mint is re-authorized server-side against the live
           * device session — so a sign-out or an account switch takes the widget's
           * content with it. Android-only; inert on web and iOS. The trending-posts
           * widget needs none of this (Explore answers anonymously) and is
           * unaffected either way.
           */}
          <OxyProvider
            oxyServices={oxyServices}
            clientId={OXY_CLIENT_ID}
            authRedirectUri={OXY_AUTH_REDIRECT_URI}
            webAuthMode="popup"
            storageKeyPrefix="mention"
            queryClient={queryClient}
            backgroundSession
          >
            {/*
             * The boot visual, held up for exactly as long as AccountSwitchReset
             * keeps account-dependent descendants unmounted. It must be supplied
             * HERE rather than below, because this gate is above the root
             * layout's own splash branch — anything the root renders is already
             * a descendant of it, so during the auth window the root's splash
             * cannot paint at all. Static (no `startFade`), so it holds at full
             * opacity until the gate opens and the root takes over.
             */}
            <AccountSwitchReset fallback={<AppSplashScreen />}>
              <I18nextProvider i18n={i18n}>
                {/*
                 * `LayoutScrollProvider` and `AppShellProviders` sit ABOVE
                 * `BottomSheetProvider` — and above this component's own
                 * `children` — on purpose, and moving either back down
                 * reintroduces a crash.
                 *
                 * Two surfaces render content far above where its JSX was
                 * written, and React resolves context by RENDER position:
                 * `BottomSheetProvider` parks whatever `setBottomSheetContent`
                 * is handed in state and renders it beside its own children, and
                 * bloom's NATIVE portal group re-parents `<Portal>` children onto
                 * the `<Outlet/>` that `app/_layout.tsx` mounts among the
                 * children below. Both land at THIS depth. While the app-shell
                 * contexts lived in `app/(app)/_layout.tsx`, anything either
                 * surface rendered was outside all of them — the composer's GIF
                 * picker asked for the video playback authority from inside a
                 * sheet and threw.
                 *
                 * `AppShellProviders` needs `LayoutScrollProvider` above it
                 * (`BottomBarVisibilityProvider` reads the shared scroll
                 * position), which is why that one moved up too. The tree below
                 * is unchanged.
                 */}
                <LayoutScrollProvider>
                  <AppShellProviders>
                    <BottomSheetProvider>
                      <MenuProvider>
                        <AppErrorBoundary
                          onError={handleBoundaryError}
                        >
                          <LiveRoomControllerProvider>
                            <HomeRefreshProvider>
                              {children}
                              <StatusBar style="auto" />
                              {/*
                               * No <ToastOutlet /> here on purpose. Bloom's toast
                               * stack must be mounted exactly once — every mount
                               * subscribes to the same store and renders the same
                               * rows, so a second outlet shows every toast twice.
                               * OxyProvider above already mounts one at the app
                               * root, and it carries Bloom's defaults.
                               */}
                              <ConfirmPromptProvider />
                              <ActionMenuHost />
                              <ContentDialogHost />
                              <FediverseInfoDialogProvider />
                              <ChannelInfoDialogProvider />
                            </HomeRefreshProvider>
                            <LiveFeatureHost />
                          </LiveRoomControllerProvider>
                        </AppErrorBoundary>
                      </MenuProvider>
                    </BottomSheetProvider>
                  </AppShellProviders>
                </LayoutScrollProvider>
              </I18nextProvider>
            </AccountSwitchReset>
          </OxyProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});
