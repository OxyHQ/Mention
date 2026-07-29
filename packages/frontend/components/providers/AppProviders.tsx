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
import { AccountSwitchReset } from '@/components/providers/AccountSwitchReset';
import { BottomSheetProvider } from '@/context/BottomSheetContext';
import { HomeRefreshProvider } from '@/context/HomeRefreshContext';
import { LayoutScrollProvider } from '@/context/LayoutScrollContext';
import { OXY_CLIENT_ID, OXY_AUTH_REDIRECT_URI } from '@/config';
import { ConfirmPromptProvider } from '@/components/common/ConfirmPrompt';
import { ActionMenuHost } from '@/components/common/ActionMenu';
import { ContentDialogHost } from '@/components/common/ContentDialog';
import { FediverseInfoDialogProvider } from '@/components/Fediverse/FediverseInfoDialog';
import { LiveFeatureHost } from '@/components/providers/LiveFeatureProviders';
import { LiveRoomControllerProvider } from '@/context/LiveRoomContext';
import i18n from '@/lib/i18n';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('AppProviders');

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
    logger.error('Error caught by boundary', { error, errorInfo });
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
          <OxyProvider
            oxyServices={oxyServices}
            clientId={OXY_CLIENT_ID}
            authRedirectUri={OXY_AUTH_REDIRECT_URI}
            webAuthMode="popup"
            storageKeyPrefix="mention"
            queryClient={queryClient}
          >
            <AccountSwitchReset>
              <I18nextProvider i18n={i18n}>
                <BottomSheetProvider>
                  <MenuProvider>
                    <AppErrorBoundary
                      onError={handleBoundaryError}
                    >
                      <LiveRoomControllerProvider>
                        <LayoutScrollProvider>
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
                          </HomeRefreshProvider>
                        </LayoutScrollProvider>
                        <LiveFeatureHost />
                      </LiveRoomControllerProvider>
                    </AppErrorBoundary>
                  </MenuProvider>
                </BottomSheetProvider>
              </I18nextProvider>
            </AccountSwitchReset>
          </OxyProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});
